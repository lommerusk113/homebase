// Checks before done: per-project check commands (checks.json in the Homebase dir, set by POST /api/checks) that the Stop hook
// (hooks/checks.mjs) runs when a chat Homebase started tries to end its turn. The commands come only from that file, never from
// the repo or the chat. The hook's last result per session is checks/<session>.json, read for the board chip.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMEOUT_MS = 300_000;
export const MAX_STRIKES = 3; // blocked stops in a row with the same failure, then the stop is allowed
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const dir = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
const read = file => {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};
const write = (file, data) => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(data), { mode: 0o600 });
    renameSync(`${file}.${process.pid}.tmp`, file);
};

const configFile = d => join(d, 'checks.json');
export const readChecks = (project, d = dir()) => {
    const c = read(configFile(d))?.[project];
    return Array.isArray(c) ? c.filter(x => typeof x === 'string' && x.trim()) : [];
};

// body: JSON { commands: string[] }. Throws 400 for anything else. Returns the saved commands.
export function saveChecks(project, body, d = dir()) {

    let b;
    try {
        b = JSON.parse(body);
    } catch {}
    if (!/^[\w.-]+$/.test(project ?? '') || !Array.isArray(b?.commands) || b.commands.some(c => typeof c !== 'string' || c.length > 1000)) {
        throw Object.assign(new Error('expected ?project= and {commands: string[]}'), { status: 400 });
    }

    const all = read(configFile(d)) ?? {};
    all[project] = b.commands.map(c => c.trim()).filter(Boolean);
    write(configFile(d), all);

    return { commands: all[project] };
}

// The settings file Homebase hands to chats it starts (claude --settings): only the Stop hook, never ~/.claude/settings.json.
export function settingsFlag(d = dir(), root = fileURLToPath(new URL('..', import.meta.url))) {

    const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
    const file = join(d, 'checks-settings.json');
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${quote(join(root, 'hooks', 'checks.mjs'))}`, timeout: 330 }] }] } };
    try {
        if (!existsSync(file) || readFileSync(file, 'utf8') !== JSON.stringify(settings)) {
            write(file, settings);
        }
    } catch {
        return '';
    }

    return ` --settings ${quote(file)}`;
}

const statusFile = (d, id) => join(d, 'checks', `${id}.json`);

// { state: 'pass' | 'fail' | 'running', at } for the board chip, or null. A running mark older than the timeout is a killed hook.
export function checksStatus(id, d = dir(), now = Date.now()) {

    const s = SESSION_ID.test(id ?? '') ? read(statusFile(d, id)) : null;
    if (!s || (s.state === 'running' && now - s.at > TIMEOUT_MS + 30_000)) {
        return null;
    }

    return { state: s.state, at: s.at };
}

const git = (cwd, args) => {
    try {
        return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return '';
    }
};

// Same name the board uses for the project: origin's repo name, else the main checkout's folder.
export function projectOfCwd(cwd) {

    const origin = git(cwd, ['remote', 'get-url', 'origin']).trim();
    if (origin) {
        return basename(origin.replace(/\.git$/, '').replace(/^.*:/, ''));
    }
    const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();

    return common ? basename(dirname(common)) : basename(cwd);
}

// `git diff HEAD` has no untracked files' content, so their blob hashes go in too: editing a new file counts as a change.
export function changeHash(cwd) {

    const untracked = git(cwd, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean)
        .map(f => `${f}:${git(cwd, ['hash-object', '--', f]).trim()}`);

    return createHash('sha1').update(git(cwd, ['status', '--porcelain'])).update('\0').update(git(cwd, ['diff', 'HEAD'])).update('\0').update(untracked.join('\n')).digest('hex');
}

// Runs one command in cwd through sh, as the user's own config said. { ok, out } with stdout and stderr together.
export function runCommand(cmd, cwd) {

    try {
        const out = execFileSync('sh', ['-c', `exec 2>&1\n${cmd}`], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 16 << 20 });

        return { ok: true, out };
    } catch (e) {
        return { ok: false, out: `${e.stdout ?? ''}${e.code === 'ETIMEDOUT' ? `\n(timed out after ${TIMEOUT_MS / 1000}s)` : ''}${e.stdout ? '' : e.message}` };
    }
}

const lastLines = (t, n = 30) => t.trimEnd().split('\n').slice(-n).join('\n');

// The Stop hook's decision for input h (Claude Code's hook JSON): null to allow the stop, or { decision: 'block', reason }.
export function decide(h, { d = dir(), run = runCommand, now = Date.now } = {}) {

    const cwd = h.cwd;
    if (!SESSION_ID.test(h.session_id ?? '') || !cwd) {
        return null;
    }
    const cmds = readChecks(projectOfCwd(cwd), d);
    if (!cmds.length) {
        return null;
    }

    const file = statusFile(d, h.session_id);
    const prev = read(file) ?? {};
    const hash = changeHash(cwd);
    if (prev.state === 'pass' && prev.hash === hash) {
        return null;
    }

    write(file, { ...prev, state: 'running', at: now() });
    for (const cmd of cmds) {
        const r = run(cmd, cwd);
        if (r.ok) {
            continue;
        }

        const failure = `${cmd}\n${lastLines(r.out)}`;
        const sig = createHash('sha1').update(failure).digest('hex');
        const strikes = prev.sig === sig ? (prev.strikes ?? 0) + 1 : 1;
        const giveUp = strikes > MAX_STRIKES;
        write(file, { state: 'fail', at: now(), hash, sig, strikes, gaveUp: giveUp }); // gaveUp: "checks failing", the stop was allowed

        return giveUp ? null : { decision: 'block', reason: `Check failed: ${failure}\nFix it before finishing.` };
    }

    write(file, { state: 'pass', at: now(), hash, strikes: 0 });

    return null;
}
