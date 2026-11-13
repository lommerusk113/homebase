// tmux plumbing: the socket override, session names, /clear aliases, and the keystroke steps for a message.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// HOMEBASE_TMUX_SOCKET points every tmux call at a separate server (tmux -L), so tests never touch real sessions.
export const tmuxArgs = (args, socket = process.env.HOMEBASE_TMUX_SOCKET) => (socket ? ['-L', socket, ...args] : args);
export const tmux = args => run('tmux', tmuxArgs(args));

// ponytail: login+interactive zsh so PATH matches your terminal; id is validated, cwd is passed as its own arg
const claudeCmd = id => ['/bin/zsh', '-lic', `claude --resume ${id}`];

// tmux keeps Claude running between messages; `tmux attach -t cc-<id8>` reaches it from any terminal.
export const tmuxName = id => `cc-${id.slice(0, 8)}`;

// /clear starts a new session id in the same process, so the new id keeps the old tmux name.
// ponytail: in memory; after a server restart a cleared session gets its own tmux on the next send
export const aliases = new Map(); // new session id -> { tmux, from }
export const clears = []; // pending { from, tmux, cwd, clearedAt }, until the new transcript shows up
export const CLEAR_WAIT_MS = 60_000;

export const tmuxFor = (id, map = aliases) => map.get(id)?.tmux ?? tmuxName(id);

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
