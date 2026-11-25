// "Start from issue": POST /api/issues/start { project, iid } makes the issue's branch and worktree from origin/<target>
// and starts a chat there with the issue prompt typed into its composer, unsent. Never pushes, never touches a remote branch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { api, isGitLab, signedIn } from './forge.mjs';
import { repoPaths, sessions } from './sessions.mjs';
import { slug } from './items.mjs';
import { canned } from '../web/src/lib/canned.ts';
import { tmux, sleep, sendSteps } from './tmux.mjs';
import { capture } from './startup.mjs';
import { promptUp } from './control.mjs';
import { startChat, failer, listTranscripts } from './newproject.mjs';
import { reviewRequests } from './reviews.mjs';

const run = promisify(execFile);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const GIT = { timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };
const inFlight = new Set();

/** Branch name part of a title: [a-z0-9-] only, at most 40 characters, no trailing dash. */
export const branchSlug = title => slug(String(title ?? '')).slice(0, 40).replace(/-$/, '') || 'issue';

/** Request validation: iid is digits, project is one Homebase knows (a GitLab one: GitHub hobby repos have no issues). */
export function validateStart(body, repos = repoPaths) {

    const { project, iid } = body ?? {};
    if ((typeof iid !== 'string' && typeof iid !== 'number') || !/^\d{1,9}$/.test(String(iid))) {
        throw bad('iid must be digits');
    }
    const repo = typeof project === 'string' ? repos.get(project) : null;
    if (!repo) {
        throw bad('unknown project', 404);
    }
    if (!isGitLab(repo)) {
        throw bad('only GitLab projects have issues to start from', 400);
    }

    return { project, iid: String(iid), repo };
}

/** The name of whoever has the issue when `me` is not one of them, else null (nobody, or me, may start it). */
export const takenBy = (assignees, me) => (assignees?.length && !assignees.some(a => a.username === me?.username) ? assignees.map(a => a.name ?? a.username).join(', ') : null);

// The wording is web/src/lib/canned.ts's, which the transcript parser recognises. Manual: read and discuss, sent; otherwise the prompt waits unsent.
export const startPrompt = (iid, assignees, manual = false) => canned(manual ? 'startManual' : assignees?.length ? 'start' : 'startUnassigned', iid).message;

const git = (repo, ...args) => run('git', ['-C', repo, ...args], GIT).then(r => r.stdout.trim());
const has = (repo, ref) => git(repo, 'rev-parse', '--verify', '--quiet', ref).then(() => true, () => false);

/** The main checkout of a project: the git common dir of any session's cwd in it. */
async function repoDirOf(project) {

    for (const cwd of new Set((await sessions()).filter(s => s.project === project && s.cwd).map(s => s.cwd))) {
        const common = await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').catch(() => null);
        if (common) {
            return common.endsWith('/.git') ? dirname(common) : common;
        }
    }

    throw bad('no chat of this project shows where its checkout is', 404);
}

/** origin/<milestone slug> when that branch exists (v1 and v2 milestones have their own), else origin's default branch. */
export async function targetOf(repo, milestone) {

    const own = milestone?.title ? `origin/${slug(milestone.title)}` : null;
    if (own && await has(repo, `refs/remotes/${own}`)) {
        return own;
    }

    return await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => 'origin/main');
}

/** The worktree path of the issue's branch if one exists, else null. */
async function worktreeOf(repo, iid) {

    let path = null;
    for (const line of (await git(repo, 'worktree', 'list', '--porcelain')).split('\n')) {
        if (line.startsWith('worktree ')) {
            path = line.slice(9);
        } else if (new RegExp(`^branch refs/heads/${iid}-[a-z0-9-]+$`).test(line)) {
            return path;
        }
    }

    return null;
}

/** Creates (or reuses) the branch and worktree; -> { dir, reused }. */
export async function prepareWorktree(repo, iid, title, target) {

    const existing = await worktreeOf(repo, iid);
    if (existing) {
        return { dir: existing, reused: true };
    }

    const branch = (await git(repo, 'branch', '--list', `${iid}-*`, '--format=%(refname:short)'))
        .split('\n').find(b => new RegExp(`^${iid}-[a-z0-9-]+$`).test(b)) ?? `${iid}-${branchSlug(title)}`;
    const dir = join(repo, '.claude', 'worktrees', branch);
    const args = (await has(repo, `refs/heads/${branch}`)) ? [dir, branch] : ['--no-track', '-b', branch, dir, target];
    await run('git', ['-C', repo, 'worktree', 'add', ...args], GIT);

    return { dir, reused: false };
}

// Types the prompt, and presses Enter only when send is set; otherwise the user reviews it first. Waits for Claude's prompt, up to waitMs.
async function typePrompt(name, text, send, { tm, nap, waitMs }) {

    for (let t = 0; t < waitMs && !promptUp(await capture(name, tm)); t += 500) {
        await nap(500);
    }
    const steps = sendSteps(name, text);
    for (const args of send ? steps : steps.slice(0, -1)) {
        if (args.at(-1) === 'Enter') {
            await nap(300);
        }
        await tm(args);
    }
}

/** POST /api/issues/start. -> { ok, dir, tmux, sessionId, reused }. */
export async function startIssue(body, deps = {}) {

    const { repos = repoPaths, issueOf = (repo, iid) => api(repo, `projects/${encodeURIComponent(repo.path)}/issues/${iid}`), meOf = signedIn, dirOf = repoDirOf,
        tmux: tm = tmux, nap = sleep, transcripts = listTranscripts, waitMs = 20_000, trustMs = 60_000, known = sessions } = deps;
    const { project, iid, repo } = validateStart(body, repos);
    const manual = body.manual === true;

    const issue = await issueOf(repo, iid).catch(() => { throw bad(`could not read issue #${iid}`, 502); });
    const me = await meOf(repo);
    if (!me) {
        throw bad('could not tell who you are on GitLab', 502);
    }
    const assignees = (issue.assignees ?? []).map(a => ({ name: a.name, username: a.username }));
    const owner = takenBy(assignees, me);
    if (owner) {
        throw bad(`Assigned to ${owner}, only they can start it`, 403);
    }

    const key = `${project}#${iid}`;
    if (inFlight.has(key)) {
        throw bad(`#${iid} is already being started`, 409);
    }
    inFlight.add(key);

    try {
        const main = await dirOf(project);
        await git(main, 'fetch', 'origin');
        const { dir, reused } = await prepareWorktree(main, iid, issue.title, await targetOf(main, issue.milestone));

        // a chat that already runs in the worktree is opened as it is
        const there = (await known()).find(s => s.cwd === dir);
        if (reused && there) {
            return { ok: true, dir, tmux: null, sessionId: there.id, reused };
        }

        const steps = [{ id: 'chat', label: 'Starting chat', state: 'pending' }];
        const name = `${project}-${iid}`.replace(/[^A-Za-z0-9._-]/g, '-');
        const started = await startChat({ name, dir, steps, fail: failer(steps), tm, nap, transcripts, waitMs, trustMs, before: new Set(await transcripts(dir)), manual, known }, 0, `Starting Claude in ${dir} failed:`);
        if (!started.reused) { // a leftover chat of an earlier start keeps what it has
            await typePrompt(started.tmux, startPrompt(iid, assignees, manual), manual, { tm, nap, waitMs });
        }

        return { ok: true, dir, tmux: started.tmux, sessionId: started.sessionId, reused, manual };
    } finally {
        inFlight.delete(key);
    }
}

/** The prompt of a review chat: read-only, so nothing leaves the machine. */
export const reviewPrompt = r => `Review MR !${r.iid} of ${r.project} (${r.url}) using the review-gate or code-review skill. Read it with glab (mr view, mr diff), do not check it out. Read-only: do not push, comment, approve or edit anything. End with the findings.`;

/** POST /api/reviews/start { url }: a new chat in the MR's project, in its main checkout, with the review prompt sent. -> { ok, dir, tmux, sessionId, reused? }. */
export async function startReview(body, deps = {}) {

    const { requests = reviewRequests, repos = repoPaths, dirOf = repoDirOf, tmux: tm = tmux, nap = sleep, transcripts = listTranscripts, waitMs = 20_000, trustMs = 60_000, known = sessions } = deps;
    // only an MR on the review list: the url is never used for anything else
    const r = typeof body?.url === 'string' ? requests().find(x => x.url === body.url) : null;
    if (!r) {
        throw bad('not a merge request that asks you for a review', 404);
    }
    const project = r.project.split('/').pop();
    if (!repos.has(project)) {
        throw bad('unknown project', 404);
    }

    const key = `${project}!${r.iid}`;
    if (inFlight.has(key)) {
        throw bad(`!${r.iid} is already being started`, 409);
    }
    inFlight.add(key);

    try {
        const dir = await dirOf(project);
        const steps = [{ id: 'chat', label: 'Starting chat', state: 'pending' }];
        const name = `${project}-review-${r.iid}`.replace(/[^A-Za-z0-9._-]/g, '-');
        const started = await startChat({ name, dir, steps, fail: failer(steps), tm, nap, transcripts, waitMs, trustMs, before: new Set(await transcripts(dir)), known }, 0, `Starting Claude in ${dir} failed:`);
        // a leftover chat that already got the prompt is opened as it is; one that never did (its start timed out) gets it now
        if (!started.reused || !(await capture(started.tmux, tm)).includes(`Review MR !${r.iid}`)) {
            await typePrompt(started.tmux, reviewPrompt(r), true, { tm, nap, waitMs });
        }

        return { ok: true, dir, tmux: started.tmux, sessionId: started.sessionId, reused: !!started.reused };
    } finally {
        inFlight.delete(key);
    }
}
