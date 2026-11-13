// The POST actions on a session: type into its tmux session, interrupt, /clear, and open its folder in an editor.
import { readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessions } from './sessions.mjs';
import { tmux, tmuxName, tmuxFor, aliases, clears, tmuxSession, sendSteps, refuseIfLiveElsewhere, sleep } from './tmux.mjs';

const run = promisify(execFile);

const EDITORS = [
    { id: 'idea', name: 'IntelliJ IDEA', app: /^IntelliJ IDEA.*\.app$/, cli: 'idea' },
    { id: 'vscode', name: 'VS Code', app: /^Visual Studio Code.*\.app$/, cli: 'code' }
];
// apps: .app paths found; clis: command name -> path. An app wins (open -a), else the CLI.
export function editorsFrom(apps, clis) {
    return EDITORS.flatMap(e => {
        const app = apps.find(a => e.app.test(basename(a)));
        const cmd = app ? ['open', ['-a', app]] : clis[e.cli] ? [clis[e.cli], []] : null;

        return cmd ? [{ id: e.id, name: e.name, cmd }] : [];
    });
}

async function detectEditors() {

    const appDirs = ['/Applications', join(homedir(), 'Applications'), join(homedir(), 'Applications', 'JetBrains Toolbox')];
    const apps = (await Promise.all(appDirs.map(d => readdir(d).then(fs => fs.map(f => join(d, f)), () => [])))).flat();

    const binDirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), join(homedir(), 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts')];
    const clis = {};
    for (const name of EDITORS.map(e => e.cli)) {
        for (const d of binDirs) {
            const ok = await access(join(d, name), constants.X_OK).then(() => true, () => false);
            if (ok) {
                clis[name] = join(d, name);
                break;
            }
        }
    }

    return editorsFrom(apps, clis);
}
let editorList = null;
export const editors = () => (editorList ??= detectEditors());

// Only known items, only the folder the server resolved; the client names an item and an editor, never a path.
export async function openInEditor(key, editorId, { list = sessions, eds = editors, exec = run } = {}) {

    const ed = (await eds()).find(e => e.id === editorId);
    if (!ed) {
        throw Object.assign(new Error('unknown editor'), { status: 400 });
    }

    const it = (await list()).flatMap(s => s.items ?? []).find(i => i.key === key);
    if (!it?.folder) {
        throw Object.assign(new Error(it ? 'folder is gone' : 'unknown item'), { status: 404 });
    }

    await exec(ed.cmd[0], [...ed.cmd[1], it.folder]);
}

// Only known sessions, only their recorded cwd.
async function resumable(id) {

    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) {
        throw new Error('bad id');
    }

    const s = (await sessions()).find(x => x.id === id);
    if (!s?.cwd) {
        throw new Error('unknown session');
    }
    try {
        await stat(s.cwd);
    } catch {
        throw new Error(`folder is gone: ${s.cwd}`);
    }

    return s;
}

export async function send(id, text, s = null) {

    s ??= await resumable(id);
    let name = tmuxFor(id);
    let steps = sendSteps(name, text);

    try {
        await tmux(['has-session', '-t', `=${name}`]);
    } catch {
        aliases.delete(id); // the aliased tmux session is gone: start one of its own
        name = tmuxName(id);
        steps = sendSteps(name, text);
        refuseIfLiveElsewhere(Date.now() - s.updated);
        await tmux(['new-session', '-d', ...tmuxSession(id, s.cwd)]);
        await sleep(5000); // ponytail: fixed wait for claude to boot; poll capture-pane for its prompt if this proves flaky
    }

    for (const args of steps) {
        if (args.at(-1) === 'Enter') {
            await sleep(300); // a separate, later Enter so Claude doesn't treat it as part of the typed/pasted text
        }
        await tmux(args);
    }

    return name;
}

// Escape interrupts Claude's turn, so queued messages are handled right away. Only in our own tmux session.
export async function interrupt(id) {

    await resumable(id);
    const name = tmuxFor(id);

    try {
        await tmux(['has-session', '-t', `=${name}`]);
    } catch {
        throw Object.assign(new Error("Session isn't running in Homebase's tmux"), { status: 409 });
    }

    await tmux(['send-keys', '-t', name, 'Escape']);
}

// Types /clear (same checks as send) and remembers it, so the next session list maps the new transcript to this tmux session.
export async function clearChat(id) {

    const s = await resumable(id);
    const c = { from: id, tmux: tmuxFor(id), cwd: s.cwd, clearedAt: Date.now() };
    clears.push(c);
    try {
        c.tmux = await send(id, '/clear', s); // send may have replaced a dead aliased tmux session
    } catch (e) {
        clears.splice(clears.indexOf(c), 1);
        throw e;
    }
}
