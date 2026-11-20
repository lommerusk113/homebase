// Claude Code reads its instruction files only when a process starts, so a chat started before they changed runs old rules.
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RULES_FILE } from './tmux.mjs';

const TTL_MS = 10_000;
const mtimes = new Map(); // path -> { at, mtime }

// [name shown, path] of the files whose change makes a running chat stale
export const watched = (cwd, home = homedir()) => [
    ['homebase-rules.md', RULES_FILE],
    ['CLAUDE.md', join(home, '.claude', 'CLAUDE.md')],
    ['CLAUDE.md', join(cwd, 'CLAUDE.md')],
    ['AGENTS.md', join(cwd, 'AGENTS.md')]
];

async function mtimeOf(path, now) {

    const hit = mtimes.get(path);
    if (hit && now - hit.at < TTL_MS) {
        return hit.mtime;
    }

    const mtime = await stat(path).then(st => st.mtimeMs, () => null);
    mtimes.set(path, { at: now, mtime });

    return mtime;
}

// Names (once each) of the watched files modified after the process started, and the newest such mtime; undefined when none, or the start is unknown.
export async function rulesStale(startedAt, cwd, now = Date.now(), home = homedir()) {

    if (!startedAt || !cwd) {
        return undefined;
    }

    const names = new Set();
    let at = 0;
    for (const [name, path] of watched(cwd, home)) {
        const m = await mtimeOf(path, now);
        if (m > startedAt) {
            names.add(name);
            at = Math.max(at, m);
        }
    }

    return names.size ? { names: [...names], at } : undefined;
}
