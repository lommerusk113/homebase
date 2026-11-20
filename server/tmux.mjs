// tmux plumbing: the socket override, session names, /clear aliases, and the keystroke steps for a message.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

// HOMEBASE_TMUX_SOCKET points every tmux call at a separate server (tmux -L), so tests never touch real sessions.
export const tmuxArgs = (args, socket = process.env.HOMEBASE_TMUX_SOCKET) => (socket ? ['-L', socket, ...args] : args);
export const tmux = args => run('tmux', tmuxArgs(args), { timeout: 5000 }); // a hung tmux fails instead of freezing the board

// Homebase's own rules (homebase-rules.md: how replies and questions fit its UI), added to every Claude it starts or resumes
export const RULES_FILE = fileURLToPath(new URL('../homebase-rules.md', import.meta.url));
export const claudeLine = (extra = '', rules = RULES_FILE) => `claude${existsSync(rules) ? ` --append-system-prompt-file '${rules.replace(/'/g, `'\\''`)}'` : ''}${extra}`;

// ponytail: login+interactive shell (your $SHELL; zsh and bash both take -lic) so PATH matches your terminal; id is validated, cwd is passed as its own arg
const claudeCmd = id => [process.env.SHELL || '/bin/zsh', '-lic', claudeLine(` --resume ${id}`)];

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

// The newest transcript in the same cwd created after a /clear (within CLEAR_WAIT_MS): the cleared session's successor.
// ponytail: a session started by hand in the same folder within that minute could be mistaken for it
export function findClearedSuccessor(sessions, { from, cwd, clearedAt }) {

    const hits = sessions.filter(s => s.id !== from && s.cwd === cwd && s.created >= clearedAt && s.created - clearedAt < CLEAR_WAIT_MS);

    return hits.sort((a, b) => b.created - a.created)[0] ?? null;
}
export const tmuxSession = (id, cwd) => ['-s', tmuxName(id), '-c', cwd, ...claudeCmd(id)];

export const MAX_SEND = 20 * 1024;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// tmux argument lists that type `text` into session `name` and submit it. Multi-line text goes in as one
// bracketed paste, since a literal newline would submit the first line on its own.
export function sendSteps(name, text) {

    const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    if (!clean) {
        throw new Error('empty message');
    }

    const enter = ['send-keys', '-t', name, 'Enter'];
    if (!clean.includes('\n')) {
        return [['send-keys', '-t', name, '-l', '--', clean], enter];
    }

    return [['set-buffer', '-b', name, '--', clean], ['paste-buffer', '-p', '-d', '-b', name, '-t', name], enter];
}

const LIVE_ELSEWHERE_MS = 2 * 60_000;

// A recently written transcript without our tmux session means Claude runs in another terminal; a second one would share the transcript.
export function refuseIfLiveElsewhere(ageMs) {

    if (ageMs < LIVE_ELSEWHERE_MS) {
        throw Object.assign(new Error('This session is open in another terminal. Close it there first.'), { status: 409 });
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
