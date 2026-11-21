// `node server.mjs --doctor` checks the install; `--setup` adds Homebase's hooks and statusline to Claude's settings file.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { loginShell } from './tmux.mjs';

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
export const missingTools = () => [!onPath('tmux') && 'tmux', !hasClaude() && 'claude'].filter(Boolean);

// The five hook entries and the statusline for this checkout (same as the README)
export const wanted = (root = ROOT) => {
    const hook = extra => ({ type: 'command', command: `node ${root}/hooks/asking.mjs`, ...extra });
    return {
        hooks: {
            PreToolUse: { matcher: 'AskUserQuestion', hooks: [hook()] },
            PostToolUse: { hooks: [hook({ async: true })] },
            Notification: { matcher: 'permission_prompt', hooks: [hook()] },
            UserPromptSubmit: { hooks: [hook()] },
            Stop: { hooks: [hook()] }
        },
        statusLine: { type: 'command', command: `${root}/scripts/statusline.sh` }
    };
};

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasHook = (settings, event, root) => (settings.hooks?.[event] ?? []).some(e => (e.hooks ?? []).some(h => h.command === `node ${root}/hooks/asking.mjs`));

// Returns { settings, added: [names], conflict } without mutating the input; existing keys and hooks stay as they are
export function merge(settings, root = ROOT) {
    const want = wanted(root);
    const out = structuredClone(settings);
    const added = [];
    for (const [event, entry] of Object.entries(want.hooks)) {
        if (!hasHook(out, event, root)) {
            out.hooks ??= {};
            (out.hooks[event] ??= []).push(entry);
            added.push(`hook ${event}`);
        }
    }
    let conflict = null;
    const cur = out.statusLine;
    if (!cur) {
        out.statusLine = want.statusLine;
        added.push('statusLine');
    } else if (cur.command !== want.statusLine.command) {
        conflict = cur;
    }
    return { settings: out, added, conflict };
}

export function doctor(root = ROOT, path = settingsPath()) {
    const rows = [];
    const row = (name, ok, fix, required = true) => rows.push({ name, ok, fix, required });
    const major = Number(process.versions.node.split('.')[0]);
    row(`node ${process.versions.node}`, major >= 20, 'install Node 20 or newer');
    row('tmux', onPath('tmux'), 'install tmux (brew install tmux)');
    row('claude', hasClaude(), 'install the Claude Code CLI and sign in');
    row('gh', onPath('gh'), 'optional: install gh to see GitHub PRs', false);
    let settings = {};
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        settings = isObject(parsed) ? parsed : {};
    } catch { /* missing or unreadable: every entry reads as missing */ }
    const m = merge(settings, root);
    for (const event of Object.keys(wanted(root).hooks)) {
        row(`hook ${event} in ${path}`, !m.added.includes(`hook ${event}`), 'run: node server.mjs --setup');
    }
    row(`statusline in ${path}`, !m.added.includes('statusLine') && !m.conflict, 'run: node server.mjs --setup', false);
    const lines = rows.map(r => `${r.ok ? 'ok     ' : 'missing'} ${r.name}${r.ok ? '' : ` -- ${r.fix}`}`);
    return { lines, failed: rows.some(r => !r.ok && r.required) };
}

// ask(question) -> boolean; returns the message to print
export async function setup(root = ROOT, path = settingsPath(), ask = defaultAsk) {
    let raw = null;
    let settings = {};
    if (existsSync(path)) {
        raw = readFileSync(path, 'utf8');
        try {
            settings = JSON.parse(raw);
        } catch (e) {
            return `${path} is not valid JSON (${e.message}); fix it first, nothing changed`;
        }
        if (!isObject(settings)) {
            return `${path} does not hold a JSON object; fix it first, nothing changed`;
        }
    }
    const { settings: next, added, conflict } = merge(settings, root);
    if (conflict) {
        console.log(`Your statusLine is already ${JSON.stringify(conflict)}, not Homebase's ${root}/scripts/statusline.sh.`);
        if (await ask('Replace it with Homebase\'s? [y/N] ')) {
            next.statusLine = wanted(root).statusLine;
            added.push('statusLine (replaces yours)');
        }
    }
    if (!added.length) {
        return 'Nothing to do: nothing missing, or you kept your statusline';
    }
    const want = wanted(root);
    const entry = name => (name.startsWith('hook ') ? want.hooks[name.slice(5)] : want.statusLine);
    console.log(`Will add to ${path}:\n${added.map(a => `  + ${a}: ${JSON.stringify(entry(a))}`).join('\n')}`);
    if (!(await ask('Write it (a backup is saved first)? [y/N] '))) {
        return 'Aborted, nothing changed';
    }
    mkdirSync(dirname(path), { recursive: true });
    let backup = '';
    if (raw !== null) {
        backup = `${path}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
        copyFileSync(path, backup);
    }
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    return `Done${backup ? `, backup at ${backup}` : ''}`;
}

async function defaultAsk(q) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return /^y(es)?$/i.test((await rl.question(q)).trim());
    } finally {
        rl.close();
    }
}
