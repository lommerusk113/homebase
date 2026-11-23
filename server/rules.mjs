// Claude Code reads its instruction files only when a process starts, so a chat started before they changed runs old rules.
import { stat, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { RULES_FILE } from './tmux.mjs';
import { saverFile } from './saver.mjs';
import { canned } from '../web/src/lib/canned.ts';

const TTL_MS = 10_000;
const mtimes = new Map(); // path -> { at, mtime }

// [name shown, path] of the files whose change makes a running chat stale
export const watched = (cwd, home = homedir()) => [
    [basename(RULES_FILE), RULES_FILE],
    ['CLAUDE.md', join(home, '.claude', 'CLAUDE.md')],
    ['CLAUDE.md', join(cwd, 'CLAUDE.md')],
    ['AGENTS.md', join(cwd, 'AGENTS.md')],
    ['token-saver.md', saverFile()]
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

    const names = new Set(), project = [];
    let at = 0;
    for (const [name, path] of watched(cwd, home)) {
        const m = await mtimeOf(path, now);
        if (m > startedAt) {
            names.add(name);
            at = Math.max(at, m);
            if (path.startsWith(join(cwd, '/')) || path === saverFile()) { // "Load new rules" names these two kinds
                project.push(path);
            }
        }
    }

    return names.size ? { names: [...names], at, reload: reloadMessage(project) } : undefined;
}

// What "Load new rules" types into the chat: re-read the global rules, plus the project's own files that changed.
export const reloadMessage = (project = []) => canned('rules', [RULES_FILE, '~/.claude/CLAUDE.md', ...project].join(' and ').replace(/ and (?=.* and )/g, ', ')).message;

// Which rules a chat has been told about (loaded or dismissed) is a fact about the chat, so it lives here (rules-seen.json: id -> newest mtime), not in each browser.
const SEEN_DIR = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');

export async function readSeen(dir = SEEN_DIR()) {

    try {
        return JSON.parse(await readFile(join(dir, 'rules-seen.json'), 'utf8'));
    } catch {
        return {};
    }
}

// body: JSON { id, at }. Throws 400 for anything else.
export async function saveSeen(body, dir = SEEN_DIR()) {

    let b;
    try {
        b = JSON.parse(body);
    } catch {}
    if (typeof b?.id !== 'string' || !b.id || b.id.length > 200 || !Number.isFinite(b.at)) {
        throw Object.assign(new Error('expected {id, at}'), { status: 400 });
    }

    const seen = await readSeen(dir), file = join(dir, 'rules-seen.json');
    seen[b.id] = Math.max(seen[b.id] ?? 0, b.at);
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(seen), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
}
