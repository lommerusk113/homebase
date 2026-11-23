// tmux plumbing: the socket override, session names, /clear aliases, and the keystroke steps for a message.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saverOn, SAVER_RULE } from './saver.mjs';
import { isManual, MANUAL_RULE } from './manual.mjs';

const run = promisify(execFile);

// HOMEBASE_TMUX_SOCKET points every tmux call at a separate server (tmux -L), so tests never touch real sessions.
export const tmuxArgs = (args, socket = process.env.HOMEBASE_TMUX_SOCKET) => (socket ? ['-L', socket, ...args] : args);
export const tmux = args => run('tmux', tmuxArgs(args), { timeout: 5000 }); // a hung tmux fails instead of freezing the board

// Homebase's own rules (homebase-rules.md: how replies and questions fit its UI), added to every Claude it starts or resumes
// A gitignored homebase-rules.local.md next to it replaces the tracked file, so your own rules survive a git pull.
export const rulesFile = (dir = fileURLToPath(new URL('..', import.meta.url))) => {
    const local = join(dir, 'homebase-rules.local.md');
    return existsSync(local) ? local : join(dir, 'homebase-rules.md');
};
export const RULES_FILE = rulesFile();
export const quoted = t => `'${t.replace(/'/g, `'\\''`)}'`;
// saver: Token saver on adds its one rule as text (the file flag takes only the rules file)
// manual: a manual-mode chat adds its rule the same way
export const claudeLine = (extra = '', rules = RULES_FILE, saver = saverOn(), manual = false) => `claude${existsSync(rules) ? ` --append-system-prompt-file ${quoted(rules)}` : ''}${saver ? ` --append-system-prompt ${quoted(SAVER_RULE)}` : ''}${manual ? ` --append-system-prompt ${quoted(MANUAL_RULE)}` : ''}${extra}`;

// Your $SHELL; without one the first of zsh, bash and sh that exists (a Linux box may have no zsh)
export const loginShell = (shell = process.env.SHELL, exists = existsSync) => shell || ['/bin/zsh', '/bin/bash'].find(p => exists(p)) || '/bin/sh';
// ponytail: login+interactive shell (zsh and bash both take -lic) so PATH matches your terminal; id is validated, cwd is passed as its own arg
const claudeCmd = id => [loginShell(), '-lic', claudeLine(` --resume ${id}`, RULES_FILE, saverOn(), isManual(id))];

// tmux keeps Claude running between messages; `tmux attach -t cc-<id8>` reaches it from any terminal.
export const tmuxName = id => `cc-${id.slice(0, 8)}`;

// /clear starts a new session id in the same process, so the new id keeps the old tmux name.
// In memory only; after a server restart Claude Code's registry (liveSessions) still knows the tmux a live session runs in.
export const aliases = new Map(); // new session id -> { tmux, from }
export const clears = []; // pending { from, tmux, cwd, clearedAt }, until the new transcript shows up
export const CLEAR_WAIT_MS = 60_000;

// reg: liveSessions() (id -> tmux name); its cc-* name wins, as it survives a server restart
export const OUR_TMUX = /^cc-[A-Za-z0-9._-]{1,120}$/;
export const tmuxFor = (id, map = aliases, reg = null) => {
    const t = reg?.get(id);

    return (t && OUR_TMUX.test(t) ? t : null) ?? map.get(id)?.tmux ?? tmuxName(id);
};

// Keystrokes into one tmux session run one action at a time (send, answer, dismiss, interrupt), so two never interleave.
// ponytail: keyed by tmux name; a send that starts a new tmux under another name holds the old name's lock
const locks = new Map();
export function withLock(name, fn) {

    const run = (locks.get(name) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(name, tail);
    tail.then(() => locks.get(name) === tail && locks.delete(name));

    return run;
}

// The newest transcript in the same cwd created after a /clear (within CLEAR_WAIT_MS): the cleared session's successor.
// ponytail: a session started by hand in the same folder within that minute could be mistaken for it
export function findClearedSuccessor(sessions, { from, cwd, clearedAt }) {

    const hits = sessions.filter(s => s.id !== from && s.cwd === cwd && s.created >= clearedAt && s.created - clearedAt < CLEAR_WAIT_MS);

    return hits.sort((a, b) => b.created - a.created)[0] ?? null;
}
// Sets clearedFrom on each /clear successor: from the aliases, else, after a server restart emptied them, from the registry
// (live: liveSessions()) showing a live session in an ended one's cc-<id8> tmux. The cleared chat's question went with
// the clear, so it no longer needs you; otherwise its row opens a chat that the clear view shows as empty.
// ponytail: after a restart the registry only proves the link to the chain's first chat (the tmux is named after it); the middle
// ones of A → B → C stay unlinked, as nothing durable ties them. Upgrade: read the "SessionStart:clear" line atop each transcript
export function linkClears(sessions, live, map = aliases) {
    for (const s of sessions) {
        const t = live?.get(s.id);
        const from = map.get(s.id)?.from ?? (t && sessions.find(o => o.id !== s.id && o.cwd === s.cwd && !live.has(o.id) && tmuxName(o.id) === t)?.id);
        if (!from) {
            continue;
        }
        s.clearedFrom = from;
        const old = sessions.find(o => o.id === from);
        if (old) {
            old.needsYou = false;
        }
    }
}
export const tmuxSession = (id, cwd) => ['-s', tmuxName(id), '-c', cwd, ...claudeCmd(id)];

export const MAX_SEND = 20 * 1024;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// tmux argument lists that type `text` into session `name` and submit it. Multi-line text goes in as one
// bracketed paste, since a literal newline would submit the first line on its own.
export function sendSteps(name, text) {

    const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    if (!clean) {
        throw Object.assign(new Error('empty message'), { status: 400 });
    }
    // these would end or log out the chat's Claude
    if (/^\/(exit|quit|login|logout)\b/i.test(clean)) {
        throw Object.assign(new Error(`Homebase doesn't type ${clean.split(/\s/)[0]}: run it in the terminal`), { status: 409 });
    }

    const enter = ['send-keys', '-t', name, 'Enter'];
    // tmux takes an argument's trailing ; as its command separator and drops it; \; there is a literal one
    const arg = clean.replace(/;$/, '\\;');
    if (!clean.includes('\n')) {
        return [['send-keys', '-t', name, '-l', '--', arg], enter];
    }

    return [['set-buffer', '-b', name, '--', arg], ['paste-buffer', '-p', '-d', '-b', name, '-t', name], enter];
}

const LIVE_ELSEWHERE_MS = 2 * 60_000;
export const ELSEWHERE = 'Claude for this chat is running in a terminal outside Homebase. Quit it there (/exit), then send again.';

// A recently written transcript without our tmux session means Claude runs in another terminal; a second one would share the transcript.
export function refuseIfLiveElsewhere(ageMs) {

    if (ageMs < LIVE_ELSEWHERE_MS) {
        throw Object.assign(new Error(ELSEWHERE), { status: 409 });
    }
}

// A new project's Claude runs in cc-new-<name> before it has a transcript, so that name is also a send target.
export const NEW_TMUX = /^cc-new-[A-Za-z0-9][A-Za-z0-9._-]*$/;

let liveCache = { at: 0, list: [] };

// Every tmux session as { name, path, created } (path = its start dir, created in ms); [] without a tmux server. Cached for a moment, as every poll asks.
export async function liveTmux(now = Date.now(), list = () => tmux(['list-sessions', '-F', '#{session_name}\t#{session_path}\t#{session_created}'])) {

    if (now - liveCache.at > 2000) {
        const out = await list().then(r => r.stdout, () => '');
        liveCache = { at: now, list: out.split('\n').filter(Boolean).map(l => { const [name, path, created] = l.split('\t'); return { name, path, created: Number(created) * 1000 || 0 }; }) };
    }

    return liveCache.list;
}

// A session in the start dir of a running cc-new-* tmux session, with no tmux of its own, started after that tmux, is that project's
// chat: remember it (the earliest one, per tmux). "After" keeps an existing folder's older sessions (Open) from being taken for it. Derived on every poll, so it also holds after a server restart.
export function mapNewProjects(sessions, live, map = aliases) {

    const taken = new Set([...map.values()].map(a => a.tmux));
    const names = new Set(live.map(l => l.name));
    for (const { name, path, created = 0 } of live) {
        if (!NEW_TMUX.test(name) || taken.has(name)) {
            continue;
        }
        const own = sessions.filter(s => s.cwd === path && s.created >= created && !names.has(tmuxName(s.id)) && !map.has(s.id)).sort((a, b) => a.created - b.created)[0];
        if (own) {
            map.set(own.id, { tmux: name });
        }
    }
}

// cc-new-* tmux sessions whose folder has no transcript yet: the chats still starting.
export const startingProjects = (sessions, live) => live
    .filter(l => NEW_TMUX.test(l.name) && !sessions.some(s => s.cwd === l.path && s.created >= (l.created ?? 0)))
    .map(l => ({ tmux: l.name, name: l.name.slice('cc-new-'.length), dir: l.path }));
