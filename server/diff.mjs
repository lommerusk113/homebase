// The Changes view (GET /api/diff): what changed in a chat's folder or a helper's worktree, read-only.
// The folder is the session's own (its cwd, or an item's worktree), never the request's; a file must be one git itself
// listed for that repo. git runs without a shell, external diff drivers, textconv, fsmonitor or index writes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sessions } from './sessions.mjs';

const run = promisify(execFile);
export const MAX_FILES = 300; // per group
export const MAX_DIFF_BYTES = 200 * 1024; // per file
const LIST_BYTES = 8 * 1024 * 1024;
const VIEW_TTL_MS = 30_000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // what a repo without commits is compared against
const DIFF = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames']; // ponytail: a rename shows as a delete and an add
const GROUPS = ['uncommitted', 'committed'];

const fail = (status, message) => Object.assign(new Error(message), { status });
const trim = s => s.replace(/\n$/, '');

// cwd is always absolute (folderFor), so it never reads as a flag; paths after `--` are literal, not pathspec patterns.
const git = (cwd, args, maxBuffer = LIST_BYTES) => run('git', ['-C', cwd, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
    { timeout: 8000, maxBuffer, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' } }).then(r => r.stdout);

// `git diff --numstat -z --no-renames`: "add\tdel\tpath\0" records, "-\t-" for a binary file. path -> { add, del, binary }
export function parseNumstat(out) {

    const counts = new Map();
    for (const rec of out.split('\0')) {
        const m = rec.match(/^(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
        if (m) {
            counts.set(m[3], m[1] === '-' ? { add: null, del: null, binary: true } : { add: Number(m[1]), del: Number(m[2]), binary: false });
        }
    }

    return counts;
}

// `git diff --name-status -z --no-renames`: "M\0path\0A\0path\0…"
export function parseNameStatus(out) {

    const parts = out.split('\0'), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
        files.push({ status: parts[i][0], path: parts[i + 1] });
    }

    return files;
}

// `git status --porcelain=v1 -z --no-renames`: "XY path\0" records. Untracked is '?', else the work-tree letter, else the staged one.
export function parseStatus(out) {

    return out.split('\0').filter(rec => rec.length > 3).map(rec => {
        const [x, y] = rec;

        return { status: x === '?' ? '?' : y !== ' ' ? y : x, path: rec.slice(3) };
    });
}

const withCounts = (files, counts) => files.map(f => ({ ...f, add: null, del: null, binary: false, ...counts.get(f.path) }));

// The default branch to compare with: origin/HEAD, else the usual names; { ref, sha } of its merge-base with HEAD.
async function baseOf(top) {

    const head = await git(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).then(trim, () => null);
    for (const ref of [head, 'origin/main', 'origin/master', 'main', 'master']) {
        const sha = ref && await git(top, ['merge-base', 'HEAD', ref]).then(trim, () => null);
        if (sha) {
            return { ref, sha };
        }
    }

    return null;
}

// { top, against, view }: the repo's root, what uncommitted changes are compared with, and what the page gets. view.repo is null when the folder is gone or not in a git repo.
export async function changes(folder) {

    const top = folder && await git(folder, ['rev-parse', '--show-toplevel']).then(trim, () => null);
    if (!top) {
        return { top: null, view: { repo: null } };
    }

    const [branch, head] = await Promise.all([
        git(top, ['branch', '--show-current']).then(trim),
        git(top, ['rev-parse', 'HEAD']).then(trim, () => null) // null: no commits yet
    ]);
    const base = head ? await baseOf(top) : null;
    const against = head ? 'HEAD' : EMPTY_TREE;
    const [status, counts, names, sums] = await Promise.all([
        git(top, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']),
        git(top, [...DIFF, '--numstat', '-z', against]),
        ...(base && base.sha !== head ? ['--name-status', '--numstat'].map(f => git(top, [...DIFF, f, '-z', base.sha, 'HEAD'])) : ['', ''])
    ]);

    const uncommitted = withCounts(parseStatus(status), parseNumstat(counts));
    const committed = withCounts(parseNameStatus(names), parseNumstat(sums));

    return {
        top,
        against,
        view: {
            repo: basename(top),
            branch: branch || (head ?? '').slice(0, 8), // a detached HEAD shows its commit
            base,
            uncommitted: uncommitted.slice(0, MAX_FILES),
            committed: committed.slice(0, MAX_FILES),
            truncated: uncommitted.length > MAX_FILES || committed.length > MAX_FILES
        }
    };
}

// One file's body: { diff } (unified), { text } (an untracked file's content), { binary: true } or { tooLarge: true }.
// path must equal a path in that group of the view, which git reported; it is never built from anything else.
export async function fileBody({ top, against, view }, group, path) {

    const file = GROUPS.includes(group) ? view[group]?.find(f => f.path === path) : null;
    if (!file) {
        throw fail(404, 'unknown file');
    }
    if (file.binary) {
        return { binary: true };
    }

    if (file.status === '?') {
        const st = await lstat(join(top, path)).catch(() => null);
        if (!st?.isFile()) { // gone, a symlink or a folder (a nested repo)
            return { text: '' };
        }
        if (st.size > MAX_DIFF_BYTES) {
            return { tooLarge: true };
        }
        const buf = await readFile(join(top, path));

        return buf.includes(0) ? { binary: true } : { text: buf.toString('utf8') };
    }

    const range = group === 'committed' ? [view.base.sha, 'HEAD'] : [against];
    try {
        return { diff: await git(top, [...DIFF, ...range, '--', path], MAX_DIFF_BYTES) };
    } catch (e) {
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            return { tooLarge: true };
        }
        throw e;
    }
}

// The folder to look at: a known session's cwd, or the worktree of one of its work items. Unknown ids are refused;
// null when the folder is gone. Absolute paths only, so none reads as a flag.
export async function diffFolder(sessionId, itemKey, list = sessions, exists = existsSync) {

    const dir = p => (typeof p === 'string' && p.startsWith('/') && exists(p) ? p : null);
    const s = (await list()).find(x => x.id === sessionId);
    if (!s) {
        throw fail(404, 'unknown session');
    }
    if (itemKey == null) {
        return dir(s.cwd);
    }

    const item = (s.items ?? []).find(i => i.key === itemKey);
    if (!item) {
        throw fail(404, 'unknown item');
    }

    return dir(item.worktreePath);
}

// The list is read afresh on every list request; the file requests that follow check their path against that same
// list for VIEW_TTL_MS instead of running git's status and diffs once more per file.
const views = new Map(); // folder -> { at, value: Promise<{ top, against, view }> }
function changesOf(folder, fresh, now = Date.now()) {

    for (const [key, hit] of views) {
        if (now - hit.at > VIEW_TTL_MS) {
            views.delete(key);
        }
    }
    if (fresh || !views.has(folder)) {
        views.set(folder, { at: now, value: changes(folder) });
    }

    return views.get(folder).value;
}

// GET /api/diff?session=<id>[&item=<key>][&group=uncommitted|committed&file=<path>]: the list, or one file's body.
export async function diff(sessionId, itemKey, group, file, list = sessions) {

    const found = await changesOf(await diffFolder(sessionId, itemKey, list), file == null);
    if (file == null) {
        return found.view;
    }
    if (!found.top) {
        throw fail(404, 'unknown file');
    }

    return fileBody(found, group, file);
}
