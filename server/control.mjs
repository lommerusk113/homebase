// The POST actions on a session: type into its tmux session, interrupt, /clear, /compact, and open its folder in an editor.
import { readdir, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sessions } from './sessions.mjs';
import { liveSessions } from './transcripts.mjs';
import { refuseIfTrustDialog, cancelQuestion, parseDialog } from './startup.mjs';
import { tmux, tmuxName, tmuxFor, aliases, clears, tmuxSession, sendSteps, refuseIfLiveElsewhere, sleep, NEW_TMUX, OUR_TMUX } from './tmux.mjs';

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

const conflict = msg => Object.assign(new Error(msg), { status: 409 });
const ELSEWHERE = 'This session is open in another terminal. Close it there first.';

// Types `text` into the session's tmux, starting one (claude --resume) when none runs. Claude Code's registry (reg) says
// which tmux a live session is in; without a registry, a dead tmux plus a fresh transcript write means another terminal.
export async function send(id, text, session = null, { tm = tmux, nap = sleep, reg = liveSessions } = {}) {

    session ??= await resumable(id);
    const live = await reg();
    if (live?.has(id) && !OUR_TMUX.test(live.get(id) ?? '')) {
        throw conflict(ELSEWHERE);
    }

    let name = tmuxFor(id, aliases, live);
    let steps = sendSteps(name, text);

    try {
        await tm(['has-session', '-t', `=${name}`]);
    } catch {
        if (live?.has(id)) {
            throw conflict(ELSEWHERE); // running in a cc-* tmux this server can't see
        }
        aliases.delete(id); // the aliased tmux session is gone: start one of its own
        name = tmuxName(id);
        steps = sendSteps(name, text);
        if (!live) {
            refuseIfLiveElsewhere(Date.now() - session.updated);
        }
        await tm(['new-session', '-d', ...tmuxSession(id, session.cwd)]);
        await nap(5000); // ponytail: fixed wait for claude to boot; poll capture-pane for its prompt if this proves flaky
    }

    await refuseIfTrustDialog(name, { tm });
    await cancelQuestion(name, { tm, nap });
    await typeSteps(steps, { tm, nap });

    return name;
}

async function typeSteps(steps, { tm = tmux, nap = sleep } = {}) {
    for (const args of steps) {
        if (args.at(-1) === 'Enter') {
            await nap(300); // a separate, later Enter so Claude doesn't treat it as part of the typed/pasted text
        }
        await tm(args);
    }
}

// A new project's chat before its transcript exists: typed into its cc-new-<name> tmux session, if that is running.
export async function sendToNew(name, text, { tm = tmux, nap = sleep } = {}) {

    if (!NEW_TMUX.test(name ?? '')) {
        throw Object.assign(new Error('bad tmux name'), { status: 400 });
    }

    const steps = sendSteps(name, text);
    try {
        await tm(['has-session', '-t', `=${name}`]);
    } catch {
        throw conflict(`${name} isn't running`);
    }

    await refuseIfTrustDialog(name, { tm });
    await cancelQuestion(name, { tm, nap });
    await typeSteps(steps, { tm, nap });
}

// Escape interrupts Claude's turn, so queued messages are handled right away. Only in our own tmux session.
export async function interrupt(id, { tm = tmux, reg = liveSessions } = {}) {

    await resumable(id);
    const name = tmuxFor(id, aliases, await reg());

    try {
        await tm(['has-session', '-t', `=${name}`]);
    } catch {
        throw conflict("Session isn't running in Homebase's tmux");
    }

    await tm(['send-keys', '-t', name, 'Escape']);
}

// /compact needs an idle Claude: mid-turn it would queue behind the work, and while asking it would answer the question.
export function refuseIfBusy(s) {
    if (s.status === 'working' || s.asking) {
        throw Object.assign(new Error('busy'), { status: 409 });
    }
}

// Types /compact (same checks as send). Unlike /clear the session id stays, so nothing is remembered.
export async function compactChat(id) {

    const s = await resumable(id);
    refuseIfBusy(s);

    await send(id, '/compact', s);
}

// Types /clear (same checks as send) and remembers it, so the next session list maps the new transcript to this tmux session.
export async function clearChat(id) {

    const s = await resumable(id);
    const c = { from: id, tmux: tmuxFor(id, aliases, await liveSessions()), cwd: s.cwd, clearedAt: Date.now() };
    clears.push(c);
    try {
        c.tmux = await send(id, '/clear', s); // send may have replaced a dead aliased tmux session
    } catch (e) {
        clears.splice(clears.indexOf(c), 1);
        throw e;
    }
}

// Claude's input line: a ❯ or > at the start of a (boxed) line, with no startup dialog on screen
export const promptUp = pane => /^[│\s]*[❯>]/m.test(pane) && !parseDialog(pane);

// Kills the chat's Homebase tmux session and resumes it, so Claude reloads (e.g. an edited homebase-rules.md). Refused while Claude
// is busy. No live-elsewhere check: Homebase closed the old one itself. Answers once the new Claude shows its prompt.
export async function restartChat(id, { tm = tmux, nap = sleep, waitMs = 20_000, session = null, reg = liveSessions } = {}) {

    const s = session ?? await resumable(id);
    refuseIfBusy(s);
    const old = tmuxFor(id, aliases, await reg());

    try {
        await tm(['has-session', '-t', `=${old}`]);
    } catch {
        throw conflict("Not running in Homebase's tmux");
    }

    await tm(['kill-session', '-t', `=${old}`]);
    aliases.delete(id);
    const name = tmuxName(id);
    await tm(['new-session', '-d', ...tmuxSession(id, s.cwd)]);

    for (let waited = 0; waited < waitMs; waited += 500) {
        await nap(500);
        const pane = await tm(['capture-pane', '-p', '-t', `=${name}:`]).then(r => r?.stdout ?? '', () => '');
        if (promptUp(pane)) {
            return name;
        }
    }

    throw Object.assign(new Error("Claude restarted but its prompt didn't show within 20s"), { status: 504 });
}
