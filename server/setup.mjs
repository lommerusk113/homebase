// `node server.mjs --doctor` checks the install; `--setup` adds Homebase's hooks and statusline to Claude's settings file, `--unsetup` removes them.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loginShell } from './tmux.mjs';
import { configProblem } from './account.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
// HOMEBASE_CLAUDE_SETTINGS points at another file, so tests never touch the real one
export const settingsPath = () => process.env.HOMEBASE_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json');

const runs = (file, args) => {
    try {
        execFileSync(file, args, { stdio: 'ignore', timeout: 10_000 });
        return true;
    } catch {
        return false;
    }
};
const onPath = cmd => runs('sh', ['-c', `command -v ${cmd}`]);
// Chats start claude through the login shell, so one that only its rc file puts on the PATH counts too
const hasClaude = () => onPath('claude') || runs(loginShell(), ['-lic', 'command -v claude']);

// The newest Claude Code whose screen (server/startup.mjs) and transcript (server/transcripts.mjs) Homebase's parsing was
// checked against: the suites pass and a real chat was driven with it. Bump it after checking a newer one (CONTRIBUTING.md).
export const VERIFIED_CLAUDE = '2.1.330';
let installed = null;
// Read once (server start, --doctor), through the login shell chats start claude with. -> '2.1.330', or null when it can't be read
export function readClaudeVersion(read = () => execFileSync(loginShell(), ['-lic', 'claude --version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })) {
    try {
        installed = /(\d+\.\d+\.\d+) \(Claude Code\)/.exec(read())?.[1] ?? null;
    } catch {
        installed = null;
    }
    return installed;
}
// '' unless the Claude Code read is newer than the verified one
export const versionWarning = (version = installed) => (version && version.localeCompare(VERIFIED_CLAUDE, undefined, { numeric: true }) > 0
    ? `Claude Code ${version} is newer than ${VERIFIED_CLAUDE}, the last version Homebase was checked with: status, questions and sends may be wrong`
    : '');
export const missingTools = () => [!onPath('tmux') && 'tmux', !hasClaude() && 'claude'].filter(Boolean);

const HOOK = '/hooks/asking.mjs', LINE = '/scripts/statusline.sh';
// Claude Code runs both commands through a shell, so the path is quoted: a checkout under "My Projects" works too
const quote = s => `'${s.replace(/'/g, `'\\''`)}'`;
// The checkout a command points at, or null when it is not a Homebase command. Setup wrote the path unquoted before, so both forms count.
const rootOf = (command, prefix, tail) => {
    const c = String(command ?? '');
    if (!c.startsWith(prefix)) {
        return null;
    }
    const m = /^'(.*)'$/s.exec(c.slice(prefix.length));
    const path = m ? m[1].replaceAll(`'\\''`, '\'') : c.slice(prefix.length);
    return path.endsWith(tail) ? path.slice(0, -tail.length) : null;
};
const hookRoot = h => rootOf(h?.command, 'node ', HOOK);
const lineRoot = line => rootOf(line?.command, '', LINE);

// The five hook entries and the statusline for this checkout (same as the README)
export const wanted = (root = ROOT) => {
    const hook = extra => ({ type: 'command', command: `node ${quote(root + HOOK)}`, ...extra });
    return {
        hooks: {
            PreToolUse: { matcher: 'AskUserQuestion', hooks: [hook()] },
            PostToolUse: { hooks: [hook({ async: true })] },
            Notification: { matcher: 'permission_prompt', hooks: [hook()] },
            UserPromptSubmit: { hooks: [hook()] },
            Stop: { hooks: [hook()] }
        },
        statusLine: { type: 'command', command: quote(root + LINE) }
    };
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasHook = (settings, event, root, is = h => hookRoot(h) === root) => (settings.hooks?.[event] ?? []).some(e => (e.hooks ?? []).some(is));
// Drops this checkout's hook from an event; an entry that also holds someone else's hook keeps that one
const dropHook = (out, event, root) => {
    out.hooks[event] = out.hooks[event]
        .map(e => (Array.isArray(e.hooks) ? { ...e, hooks: e.hooks.filter(h => hookRoot(h) !== root) } : e))
        .filter(e => !Array.isArray(e.hooks) || e.hooks.length);
};
// The older unquoted form only works while the path needs no quoting
const SAFE = /^[\w@%+=:,./-]+$/;

// Returns { settings, added: [names], conflict } without mutating the input; existing keys and hooks stay as they are
export function merge(settings, root = ROOT) {
    const want = wanted(root);
    const out = structuredClone(settings);
    const added = [];
    const works = (cur, wantCommand) => cur?.command === wantCommand || SAFE.test(root);
    for (const [event, entry] of Object.entries(want.hooks)) {
        if (!hasHook(out, event, root, h => hookRoot(h) === root && works(h, entry.hooks[0].command))) {
            if (hasHook(out, event, root)) {
                dropHook(out, event, root); // unquoted under a path with a space: replaced
            }
            out.hooks ??= {};
            (out.hooks[event] ??= []).push(entry);
            added.push(`hook ${event}`);
        }
    }
    let conflict = null;
    const cur = out.statusLine;
    if (!cur || (lineRoot(cur) === root && !works(cur, want.statusLine.command))) {
        out.statusLine = want.statusLine;
        added.push('statusLine');
    } else if (lineRoot(cur) !== root) {
        conflict = cur;
    }
    return { settings: out, added, conflict };
}

// The reverse of merge: drops exactly this checkout's hooks and statusline. Returns { settings, removed: [names] } without mutating the input.
export function unmerge(settings, root = ROOT) {
    const out = structuredClone(settings);
    const removed = [];
    for (const event of Object.keys(wanted(root).hooks)) {
        if (!hasHook(out, event, root)) {
            continue;
        }
        dropHook(out, event, root);
        if (!out.hooks[event].length) {
            delete out.hooks[event];
        }
        removed.push(`hook ${event}`);
    }
    if (removed.length && !Object.keys(out.hooks).length) {
        delete out.hooks;
    }
    if (lineRoot(out.statusLine) === root) {
        delete out.statusLine;
        removed.push('statusLine');
    }
    return { settings: out, removed };
}

// Checkouts other than `root` that Homebase entries in the settings point at (a moved, deleted or second checkout)
export function otherRoots(settings, root = ROOT) {
    const hooks = Object.values(isObject(settings.hooks) ? settings.hooks : {}).flatMap(list => (Array.isArray(list) ? list : []).flatMap(e => e?.hooks ?? []));
    const roots = [...hooks.map(hookRoot), lineRoot(settings.statusLine)];
    return [...new Set(roots.filter(r => r !== null && r !== root))];
}

// configFile: Homebase's config.json, checked for being readable.
export function doctor(root = ROOT, path = settingsPath(), version = readClaudeVersion(), configFile = undefined) {
    const config = configProblem(configFile);
    const rows = [];
    // kind: what a failed row is called; only 'missing' fails the run
    const row = (name, ok, fix, kind = 'missing') => rows.push({ name, ok, fix, kind });
    const major = Number(process.versions.node.split('.')[0]);
    row(`node ${process.versions.node}`, major >= 20, 'install Node 20 or newer');
    row('macOS', process.platform === 'darwin', 'other systems are untested', 'warning');
    row('tmux', onPath('tmux'), 'install tmux (brew install tmux)');
    row(`claude${version ? ` ${version} (checked with ${VERIFIED_CLAUDE})` : ''}`, hasClaude(), 'install the Claude Code CLI and sign in');
    row('gh', onPath('gh'), 'install gh and run gh auth login to see GitHub PRs', 'optional');
    row('glab', onPath('glab'), 'install glab and run glab auth login to see GitLab MRs', 'optional');
    let settings = {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        settings = isObject(parsed) ? parsed : {};
    } catch { /* missing or unreadable: every entry reads as missing */ }
    const m = merge(settings, root);
    rows.push({ heading: `Claude settings: ${path}` });
    for (const event of Object.keys(wanted(root).hooks)) {
        row(`hook ${event}`, !m.added.includes(`hook ${event}`), 'run: node server.mjs --setup');
    }
    if (m.conflict) {
        row('statusline', false, 'you use your own; node server.mjs --setup offers Homebase\'s, which feeds the rate limits in the header', 'optional');
    } else {
        row('statusline', !m.added.includes('statusLine'), 'run: node server.mjs --setup (it feeds the rate limits in the header)', 'optional');
    }
    for (const other of otherRoots(settings, root)) {
        const gone = existsSync(other + HOOK) ? '' : ', which no longer exists';
        row(`entries for another checkout: ${other}${gone}`, false, `run node server.mjs --unsetup there${gone ? ' if you still have it' : ''}, or remove them from the file by hand`, 'warning');
    }
    if (config) {
        row(config[0], false, config[1], 'warning');
    }
    if (versionWarning(version)) {
        row(versionWarning(version), false, 'if something looks wrong, check for a newer Homebase (README, "Why tmux, not the Agent SDK")', 'warning');
    }
    const lines = rows.map(r => r.heading ?? `${(r.ok ? 'ok' : r.kind).padEnd(8)} ${r.name}${r.ok ? '' : ` -- ${r.fix}`}`);
    const missing = rows.filter(r => r.ok === false && r.kind === 'missing').length;
    lines.push(missing ? `${missing} required ${missing === 1 ? 'check is' : 'checks are'} missing; fix the lines above, then run doctor again` : 'All required checks pass: npm start');
    return { lines, failed: missing > 0 };
}

// Copies the settings file next to itself before Homebase changes it. -> the backup's path
export function backupSettings(path) {
    const backup = `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    copyFileSync(path, backup);
    return backup;
}

// Reads the settings file: { raw, settings } or { error }; a missing file is an empty object with raw null
function load(path) {
    if (!existsSync(path)) {
        return { raw: null, settings: {} };
    }
    const raw = readFileSync(path, 'utf8');
    let settings;
    try {
        settings = JSON.parse(raw);
    } catch (e) {
        return { error: `${path} is not valid JSON (${e.message}); fix it first, nothing changed` };
    }
    return isObject(settings) ? { raw, settings } : { error: `${path} does not hold a JSON object; fix it first, nothing changed` };
}

// Writes the new settings, after copying the old file to a timestamped .bak; returns the message to print
function save(path, raw, next) {
    mkdirSync(dirname(path), { recursive: true });
    let backup = '';
    if (raw !== null) {
        backup = backupSettings(path);
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return `Done${backup ? `, backup at ${backup}` : ''}`;
}

const preview = (name, want) => {
    if (!name.startsWith('hook ')) {
        return `${name}: ${want.statusLine.command}`;
    }
    const entry = want.hooks[name.slice(5)];
    return `${name}${entry.matcher ? ` (${entry.matcher})` : ''}: ${entry.hooks[0].command}`;
};

// ask(question) -> boolean; returns the message to print
export async function setup(root = ROOT, path = settingsPath(), ask = defaultAsk) {
    const { raw, settings, error } = load(path);
    if (error) {
        return error;
    }
    const { settings: next, added, conflict } = merge(settings, root);
    const want = wanted(root);
    if (conflict) {
        console.log(`Your statusLine is already ${JSON.stringify(conflict)}, not Homebase's ${want.statusLine.command}.`);
        if (await ask('Replace it with Homebase\'s? [y/N] ')) {
            next.statusLine = want.statusLine;
            added.push('statusLine (replaces yours)');
        }
    }
    if (!added.length) {
        return 'Nothing to do: nothing missing, or you kept your statusline';
    }
    console.log(`Will add to ${path}:\n${added.map(a => `  + ${preview(a, want)}`).join('\n')}`);
    console.log('This file is Claude Code\'s user settings, so the hooks run in every Claude session on this machine, not only the ones Homebase starts. `node server.mjs --unsetup` removes them again.');
    if (!(await ask('Write it (a backup is saved first)? [y/N] '))) {
        return 'Aborted, nothing changed';
    }
    return save(path, raw, next);
}

// Removes what setup added for this checkout, with the same preview, question and backup
export async function unsetup(root = ROOT, path = settingsPath(), ask = defaultAsk) {
    const { raw, settings, error } = load(path);
    if (error) {
        return error;
    }
    const { settings: next, removed } = unmerge(settings, root);
    if (!removed.length) {
        return `Nothing to do: ${path} has no entries for ${root}`;
    }
    const want = wanted(root);
    console.log(`Will remove from ${path}:\n${removed.map(r => `  - ${preview(r, want)}`).join('\n')}`);
    if (!(await ask('Write it (a backup is saved first)? [y/N] '))) {
        return 'Aborted, nothing changed';
    }
    return save(path, raw, next);
}

// A closed stdin (piped, CI) counts as "no"
async function defaultAsk(q) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await new Promise(ok => {
            rl.once('close', () => ok(''));
            rl.question(q).then(ok, () => ok(''));
        });
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}
