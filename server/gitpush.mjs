// The chat header's Push button (POST /api/push {session}): pushes the session's current branch, never the request's.
// The folder is the session's own cwd; git runs by execFile with an argument array (no shell), never forces, and
// a work repo's default branch (and main/master) is never pushed from here.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { sessions, unpushedOf, forgetUnpushed } from './sessions.mjs';

const run = promisify(execFile);
const NEVER = /^(main|master)$/;
const SAFE_BRANCH = /^[\w][\w./-]*$/; // never a flag
export const WORK_REFUSAL = 'Work repos: the default branch is never pushed from here';

const fail = (status, message) => Object.assign(new Error(message), { status });
const git = (cwd, args, exec = run) => exec('git', ['-C', cwd, ...args], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).then(r => r.stdout.trim());

// null when pushing `branch` is allowed, else the refusal. defaultBranch may be null (unknown): main/master still count.
export function pushRefusal({ hobby, branch, defaultBranch }) {

    if (!branch || !SAFE_BRANCH.test(branch)) {
        return 'No branch is checked out';
    }
    if (!hobby && (branch === defaultBranch || NEVER.test(branch))) {
        return WORK_REFUSAL;
    }

    return null;
}

const defaults = new Map(); // cwd -> default branch name, read once
export async function defaultBranchOf(cwd, exec = run) {

    if (!defaults.has(cwd)) {
        defaults.set(cwd, await git(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], exec).then(r => r.replace(/^origin\//, ''), () => null));
    }

    return defaults.get(cwd);
}

// For the session list: true when the Push button must stay hidden (a work repo on its default branch).
export async function pushBlocked(s, exec = run) {

    return !!s.cwd && !!s.branch && pushRefusal({ hobby: s.hobby, branch: s.branch, defaultBranch: s.hobby ? null : await defaultBranchOf(s.cwd, exec) }) === WORK_REFUSAL;
}

export async function pushSession(sessionId, list = sessions, exec = run, exists = existsSync) {

    const s = typeof sessionId === 'string' && (await list()).find(x => x.id === sessionId);
    if (!s) {
        throw fail(404, 'unknown session');
    }
    if (typeof s.cwd !== 'string' || !s.cwd.startsWith('/') || !exists(s.cwd)) {
        throw fail(400, 'This chat has no folder');
    }

    const branch = await git(s.cwd, ['symbolic-ref', '--short', 'HEAD'], exec).catch(() => null);
    const refusal = pushRefusal({ hobby: !!s.hobby, branch, defaultBranch: s.hobby ? null : await defaultBranchOf(s.cwd, exec) });
    if (refusal) {
        throw fail(400, refusal);
    }

    const hasUpstream = await git(s.cwd, ['rev-parse', '--abbrev-ref', `${branch}@{u}`], exec).then(() => true, () => false);
    try {
        await git(s.cwd, ['push', ...(hasUpstream ? [] : ['-u']), 'origin', branch], exec);
    } catch (e) {
        const last = String(e.stderr || e.message).trim().split('\n').filter(Boolean).pop();
        throw fail(409, last || 'git push failed');
    }
    forgetUnpushed(s.cwd);

    return { branch, unpushed: await unpushedOf(s.cwd) };
}
