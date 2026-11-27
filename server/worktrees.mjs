// Cleanup of issue worktrees: <repo>/.claude/worktrees/<iid>-<slug>, which start.mjs makes for "Start from issue", is removed once its
// MR is merged or closed, but only when it is clean (nothing uncommitted or untracked, nothing unpushed) and no chat or tmux session
// uses it; otherwise it stays and the reason is logged once. `git worktree remove` without --force, then `git branch -d` (fully merged
// only); never rm -rf, never a remote branch. Run at start and every 5 min from server.mjs, off the board's rows.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname } from 'node:path';
import { isGitLabMr } from './queue.mjs';

const run = promisify(execFile);
const GIT = { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
const gitRun = args => run('git', args, GIT);
const ISSUE_BRANCH = /^\d+-[a-z0-9-]+$/; // the branches start.mjs names

export const CHECK_MS = 5 * 60_000; // a kept worktree is looked at again after this long
const checked = new Map(); // worktree path -> { at, why }: when it was last looked at, and why it was kept

const under = (path, dir) => !!path && (path === dir || path.startsWith(`${dir}/`));

/** Why the worktree can't go yet, or null: a chat or tmux session in it, changes, or commits that were never pushed. */
export async function blocker(wt, sha, list, tmuxList, git = gitRun) {

    if (tmuxList.some(t => under(t.path, wt)) || list.some(s => under(s.cwd, wt) && (s.status !== 'idle' || s.asking || tmuxList.some(t => t.name === s.tmux)))) {
        return 'a chat or tmux session is using it';
    }
    const out = async (...args) => (await git(['-C', wt, ...args])).stdout.trim();
    if (await out('status', '--porcelain', '--untracked-files=all')) {
        return 'it has uncommitted or untracked changes';
    }
    // pushed = what the MR had at its end contains HEAD (a squash merge leaves no remote branch to compare with), or a remote has it
    const inMr = sha ? await out('merge-base', '--is-ancestor', 'HEAD', sha).then(() => true, () => false) : false;
    const unpushed = inMr ? '0' : await out('rev-list', '--count', 'HEAD', '--not', '--remotes').catch(() => '?');

    return unpushed === '0' ? null : `it has ${unpushed === '?' ? 'commits that may be' : `${unpushed} commit${unpushed === '1' ? '' : 's'}`} not pushed`;
}

/** The main checkout and the path of the worktree on `branch` under its .claude/worktrees, or null. */
async function find(project, branch, list, git) {

    for (const cwd of new Set(list.filter(s => s.project === project && s.cwd).map(s => s.cwd))) {
        const common = await git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then(r => r.stdout.trim(), () => null);
        if (!common) {
            continue;
        }
        const repo = common.endsWith('/.git') ? dirname(common) : common;
        let path = null;
        for (const line of (await git(['-C', repo, 'worktree', 'list', '--porcelain']).then(r => r.stdout, () => '')).split('\n')) {
            if (line.startsWith('worktree ')) {
                path = line.slice(9);
            } else if (line === `branch refs/heads/${branch}` && under(path, `${repo}/.claude/worktrees`)) {
                return { repo, wt: path };
            }
        }
    }

    return null;
}

/**
 * One pass over the sessions' rows: removes the clean, unused issue worktree of each merged or closed GitLab MR. tmuxList: liveTmux().
 * -> [{ wt, removed, branch }] for what it removed. Never throws; what it keeps is logged once per reason.
 */
export async function cleanupWorktrees(list, tmuxList, { git = gitRun, now = Date.now(), log = console.log } = {}) {

    const done = [];
    const items = new Map(list.flatMap(s => s.items ?? []).filter(i => isGitLabMr(i.pr) && ['merged', 'closed'].includes(i.prState?.state) && ISSUE_BRANCH.test(i.branch ?? '')).map(i => [i.key, i]));
    for (const i of items.values()) {
        try {
            const hit = await find(i.project, i.branch, list, git);
            const last = hit && checked.get(hit.wt);
            if (!hit || (last && now - last.at < CHECK_MS)) {
                continue;
            }
            const why = await blocker(hit.wt, i.prState.sha, list, tmuxList, git);
            if (why) {
                checked.set(hit.wt, { at: now, why });
                if (last?.why !== why) {
                    log(`worktree ${hit.wt} kept: ${why}`);
                }
                continue;
            }
            await git(['-C', hit.repo, 'worktree', 'remove', hit.wt]); // refuses a dirty or locked one by itself
            checked.delete(hit.wt);
            const branch = await git(['-C', hit.repo, 'branch', '-d', i.branch]).then(() => 'deleted', () => 'kept: not fully merged');
            log(`worktree ${hit.wt} removed (its MR is ${i.prState.state}); branch ${i.branch} ${branch}`);
            done.push({ wt: hit.wt, branch });
        } catch (e) {
            log(`worktree of ${i.branch} kept: ${(e.stderr || e.message).trim().split('\n')[0]}`);
        }
    }

    return done;
}
