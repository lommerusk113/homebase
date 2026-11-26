// GitLab/GitHub via glab/gh (read-only but mergeMr): PR/MR state, review comments and threads, the shared limiter and dedupe,
// the stale-while-revalidate caches (prs, swr) and the refresh button.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ghRun, accountOf, repoPaths } from './account.mjs';

const run = promisify(execFile);

export const PR_TTL_MS = 60_000;
const GH_RECHECK_MS = Number(process.env.HOMEBASE_GH_RECHECK_MS ?? 2000);
export const prs = new Map(); // url -> { at, value, pending }

// CI pipeline as { status, url, at } or null. GitLab passes the MR's head_pipeline (or legacy pipeline) as-is;
// GitHub's statusCheckRollup is rolled up to success, failed or running (CheckRuns and StatusContexts alike).
export function pipelineOf(gl, checks, prUrl) {

    if (gl) {
        return { status: gl.status, url: gl.web_url ?? null, at: gl.finished_at ?? gl.updated_at ?? null };
    }
    if (!checks?.length) {
        return null;
    }

    const outcome = c => c.conclusion || (c.status && c.status !== 'COMPLETED' ? 'PENDING' : c.state);
    const all = checks.map(outcome);
    const status = all.some(o => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED'].includes(o)) ? 'failed'
        : all.some(o => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(o) || !o) ? 'running'
            : 'success';
    const at = checks.map(c => c.completedAt ?? c.startedAt).filter(Boolean).sort().at(-1) ?? null;

    return { status, url: `${prUrl}/checks`, at };
}

// The MR/PR number in its URL, as a string.
export const mrNumber = url => url.match(/(?:merge_requests|pull)\/(\d+)/)?.[1];
// How people write the MR/PR in text: !12 on GitLab, #12 on GitHub.
export const mrRef = url => `${url.includes('/pull/') ? '#' : '!'}${mrNumber(url)}`;
// Text that names the MR by number: `!12` (`#12` on GitHub) or "MR 12" / "PR 12", the way a helper's title says it.
export const namesMr = (text, url) => new RegExp(`(?<![\\w&!#])(?:${mrRef(url)}|(?:MR|PR) ${mrNumber(url)})(?!\\d)`).test(text ?? '');
// The coarse ci flag nextStep/rowAction read: 'failing', 'running' or null.
export const ciOf = pipeline => ({ failed: 'failing', running: 'running', pending: 'running' })[pipeline?.status] ?? null;

// { host, path } of the repo a PR/MR URL belongs to; a GitHub repo a session knows by its SSH host alias keeps the alias,
// so its account is found although the URL says github.com.
export function repoOfUrl(url) {

    const m = url.match(/^https:\/\/([^/]+)\/(.+?)(?:\/-)?\/(?:merge_requests|pull)\//);
    const repo = { host: m?.[1], path: m?.[2] };
    const known = repoPaths.get(repo.path?.split('/').pop());

    return known?.path === repo.path ? known : repo;
}

// GitLab merge statuses that stop a merge for a reason other than review or CI.
const BLOCKED = { conflict: 'conflict', need_rebase: 'rebase', blocked_status: 'blocked', external_status_checks: 'checks' };

// Read-only PR/MR lookup via gh/glab. Returns { state: open|merged|closed, title, branch, reviewers, ready, blocked, changes, changesBy, draft, ci, pipeline } or null.
async function fetchPr(url) {

    const gl = url.match(/^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (gl) {
        const { stdout } = await run('glab', ['api', `projects/${encodeURIComponent(gl[1])}/merge_requests/${gl[2]}`], { timeout: apiTimeout() });
        const mr = JSON.parse(stdout);
        const state = { opened: 'open', merged: 'merged' }[mr.state] ?? 'closed';
        const status = mr.detailed_merge_status;
        const pipeline = pipelineOf(mr.head_pipeline ?? mr.pipeline);
        // ci_must_pass without a pipeline is a missing one, not a failing one
        const ci = status === 'ci_must_pass' && !pipeline ? null : { ci_must_pass: 'failing', ci_still_running: 'running' }[status] ?? ciOf(pipeline);
        // GitLab is still computing the status: keep what it said last, so ready doesn't flap
        const prev = ['unchecked', 'checking', 'approvals_syncing', 'preparing'].includes(status) ? prs.get(url)?.value : null;
        // no milestone of its own: its issue's, which beats guessing from the target branch (v1 and v2 share one branch)
        const issue = issueOf(mr.title, mr.description);
        const issueMs = !mr.milestone && issue
            ? await run('glab', ['api', `projects/${encodeURIComponent(gl[1])}/issues/${issue}`], { timeout: apiTimeout() }).then(r => JSON.parse(r.stdout).milestone, () => null)
            : null;
        const ms = mr.milestone ?? issueMs;
        // mergeable is not approved: a project without required approvals lets an unreviewed MR merge. Asked for every open
        // MR GitLab doesn't already call unapproved, so one approved while its pipeline runs or fails stays Approved
        const approvedBy = state === 'open' && !mr.draft && !['not_approved', 'draft_status', 'not_open'].includes(status)
            ? await run('glab', ['api', `projects/${encodeURIComponent(gl[1])}/merge_requests/${gl[2]}/approvals`], { timeout: apiTimeout() })
                .then(r => (JSON.parse(r.stdout).approved_by ?? []).map(a => a.user?.name).filter(Boolean)) // a failure fails the lookup: the last state stays
            : null;
        const approved = approvedBy ? approvedBy.length > 0 : status === 'not_approved' ? false : !!prev?.approved;

        return {
            state,
            title: mr.title,
            branch: mr.source_branch,
            updatedAt: Date.parse(mr.updated_at) || 0,
            createdAt: Date.parse(mr.created_at) || null,
            reviewers: (mr.reviewers ?? []).map(r => r.name),
            // ready means merge now, by someone's approval: a failing or running pipeline (GitLab allows it when CI isn't
            // required) is not ready, nor is an MR nobody approved
            ready: (prev ? prev.mergeStatus ?? status : status) === 'mergeable' && !ci && approved, // the kept status while GitLab rechecks
            // approved although its pipeline may still run or fail: the stage says Approved, the column waits for CI
            approved,
            approvedBy: approvedBy ?? prev?.approvedBy ?? [],
            blocked: BLOCKED[status] ?? prev?.blocked ?? null,
            // ponytail: the MR payload doesn't say which reviewer blocked; the /reviewers endpoint would
            changes: status === 'requested_changes' || status === 'discussions_not_resolved' || mr.blocking_discussions_resolved === false,
            changesBy: [],
            draft: !!mr.draft,
            ci,
            pipeline,
            milestone: ms ? { id: ms.id, title: ms.title, due_date: ms.due_date } : null,
            target: mr.target_branch,
            issue,
            sha: mr.sha ?? mr.diff_refs?.head_sha ?? null,
            mergeStatus: prev ? prev.mergeStatus ?? null : status ?? null // why GitLab won't merge it yet; kept like ready while GitLab is still checking
        };
    }

    const repo = repoOfUrl(url);
    const view = fields => ghRun(repo, ['pr', 'view', url, '--json', fields], { timeout: apiTimeout() });
    const fields = 'state,title,body,reviewDecision,isDraft,headRefName,baseRefName,milestone,reviewRequests,latestReviews,statusCheckRollup,headRefOid,updatedAt,createdAt,mergeable';
    // a token without read:org (the personal one) can't read reviewRequests; the reviewers then come from the reviews alone
    const ask = () => view(fields).catch(e => (/required scopes/.test(e.message) ? view(fields.replace('reviewRequests,', '')) : Promise.reject(e)));
    let pr = JSON.parse((await ask()).stdout);
    // GitHub computes mergeability on the first ask: with no earlier answer to keep, ask once more instead of showing a guess
    if (pr.mergeable === 'UNKNOWN' && !prs.get(url)?.value) {
        await new Promise(r => setTimeout(r, GH_RECHECK_MS));
        pr = JSON.parse((await ask()).stdout);
    }

    return ghPr(pr, url);
}

// A `gh pr view --json` answer as the PR state the board reads.
export function ghPr(pr, url) {

    const pipeline = pipelineOf(null, pr.statusCheckRollup, url);
    const reviews = pr.latestReviews ?? [];
    const conflict = pr.mergeable === 'CONFLICTING';
    // GitHub still computing mergeability (after a push to the base): keep what it said last, so a conflict doesn't flip to ready
    const unknown = pr.mergeable === 'UNKNOWN', prev = unknown ? prs.get(url)?.value : null;

    return {
        state: pr.state.toLowerCase(),
        title: pr.title,
        branch: pr.headRefName,
        updatedAt: Date.parse(pr.updatedAt) || 0,
        createdAt: Date.parse(pr.createdAt) || null,
        reviewers: [...new Set([...(pr.reviewRequests ?? []).map(r => r.login ?? r.name), ...reviews.map(r => r.author?.login)].filter(Boolean))],
        // an empty reviewDecision means the repo requires no review (hobby repos without branch protection)
        ready: (pr.reviewDecision === 'APPROVED' || !pr.reviewDecision) && !pr.isDraft && !ciOf(pipeline) && !conflict && (!unknown || !!prev?.ready),
        approved: pr.reviewDecision === 'APPROVED',
        blocked: conflict ? 'conflict' : prev?.blocked ?? null,
        changes: pr.reviewDecision === 'CHANGES_REQUESTED',
        changesBy: reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author?.login).filter(Boolean),
        draft: pr.isDraft,
        ci: ciOf(pipeline),
        pipeline,
        milestone: pr.milestone ? { id: pr.milestone.number, title: pr.milestone.title, due_date: pr.milestone.dueOn?.slice(0, 10) ?? null } : null,
        target: pr.baseRefName,
        issue: issueOf(pr.title, pr.body),
        sha: pr.headRefOid ?? null
    };
}

// The one write: merges a GitLab MR now, only while its head is still `sha` (what the board showed approved). No auto-merge;
// the source branch goes or stays as the MR says. Throws with status 409 and GitLab's reason when it can't merge.
export async function mergeMr(url, sha, exec = run) {

    const gl = url.match(/^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)$/);
    if (!gl || !/^[0-9a-f]{7,40}$/.test(sha ?? '')) {
        throw Object.assign(new Error('Only an open GitLab MR with a known head can be merged here'), { status: 400 });
    }
    try {
        await exec('glab', ['api', '-X', 'PUT', `projects/${encodeURIComponent(gl[1])}/merge_requests/${gl[2]}/merge`, '-f', `sha=${sha}`], { timeout: apiTimeout() });
    } catch (e) {
        throw Object.assign(new Error(`Couldn't merge: ${String(e.stderr || e.message).trim().split('\n')[0]}`), { status: 409 });
    } finally {
        prs.delete(url);
    }
}

// The issue an MR works on: "#2219 - …" in its title, else "Closes #2219" in its description.
export function issueOf(title, body) {
    return title?.match(/#(\d+)/)?.[1] ?? body?.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i)?.[1] ?? null;
}

// Whether text names an MR: its URL, `!N` (`#N` on GitHub), or its issue as `#N`.
export function mentionsMr(text, url, issue) {

    if (!text || !url) {
        return false;
    }
    if (text.includes(url)) {
        return true;
    }

    const ref = r => new RegExp(`(?<![\\w&!#])${r}(?!\\d)`).test(text);

    return !!((mrNumber(url) && namesMr(text, url)) || (issue && ref(`#${issue}`)));
}

// Stale-while-revalidate so a slow CLI call never blocks the board after the first load.
export async function prState(url) {

    if (!url) {
        return null;
    }

    let hit = prs.get(url);
    if (!hit) {
        hit = { at: 0, value: null };
        prs.set(url, hit);
    }
    // a merged or closed MR doesn't change on its own; the refresh button still rechecks a closed one
    if (Date.now() - hit.at > PR_TTL_MS && !['merged', 'closed'].includes(hit.value?.state)) {
        refetch(hit, () => apiSlot(() => fetchPr(url)));
    }
    if (!hit.at) {
        await hit.pending;
    }

    return hit.value;
}

// Why a glab/gh call failed, as the kind the page words: missing (the CLI is not installed), auth, rate, timeout or
// error (anything else, one MR's 404 too). null for no failure.
export function problemOf(e) {

    if (!e) {
        return null;
    }
    const text = String(e.stderr || e.message);

    return e.code === 'ENOENT' ? 'missing'
        : e.killed ? 'timeout'
        : /\b429\b|rate limit|too many requests/i.test(text) ? 'rate'
        : /\b401\b|unauthorized|auth login|not logged in|authentication|bad credentials/i.test(text) ? 'auth' : 'error';
}

// The forge's words for a project (or, without a known repo, an MR/PR URL): GitLab has MRs and glab, GitHub PRs and gh.
// The one place the wording is picked; the page gets the name with each session and milestone answer.
export function forgeWords(project, url) {

    const repo = repoPaths.get(project);
    const github = repo ? !isGitLab(repo) : !!url?.includes('/pull/');

    return github ? { forge: 'GitHub', mr: 'PR', aMr: 'a PR', cli: 'gh' } : { forge: 'GitLab', mr: 'MR', aMr: 'an MR', cli: 'glab' };
}

// A failure kind in a few plain words for a row, and as one line saying what to do for the board; the CLI's own text never reaches the page.
const SHORT = { missing: cli => `${cli} is not installed`, auth: () => 'not logged in', rate: () => 'rate limited', timeout: () => 'timed out', error: () => 'the lookup failed' };
const HELP = {
    missing: cli => `${cli} is not installed. Install it, then run "npm run doctor" to check the setup.`,
    auth: cli => `not logged in. Run "${cli} auth login" in a terminal, then refresh (r).`,
    rate: () => 'too many requests. It retries by itself; refresh (r) in a few minutes.',
    timeout: () => 'no answer in time. Check the network, then refresh (r).',
    error: cli => `${cli} failed. Run "npm run doctor" to check the setup, then refresh (r).`
};
export const problemText = (e, cli) => (e ? SHORT[problemOf(e)](cli) : null);

// Why the last MR/PR lookup failed, in a few plain words, or null when it worked: the old state keeps being served meanwhile.
export const prError = url => problemText(prs.get(url)?.error, forgeWords(null, url).cli);

// A project's forge for the page: { name, problem, help, checkedAt }. problem is set when a call for the whole project
// failed (its open-MR list, the review requests) or an MR lookup failed for a reason that hits them all; one MR's own
// error is only that row's. checkedAt: when the oldest still-open MR state shown was last read, null without one.
export function forgeStatus(project, urls) {

    const repo = repoPaths.get(project);
    if (!repo && !urls.length) {
        return null;
    }
    const w = forgeWords(project, urls[0]);
    const lookups = urls.map(u => prs.get(u)).filter(Boolean);
    const wide = [swr.get(`open:${project}`), repo && swr.get(`reviews:${repo.host}`)].find(h => h?.error)?.error
        ?? lookups.map(h => h.error).find(e => e && problemOf(e) !== 'error');
    const live = lookups.filter(h => h.okAt && !['merged', 'closed'].includes(h.value?.state));

    return { name: w.forge, problem: problemOf(wide), help: wide ? HELP[problemOf(wide)](w.cli) : null, checkedAt: live.length ? Math.min(...live.map(h => h.okAt)) : null };
}

export const swr = new Map(); // key -> { at, value, pending, error }

// Runs at most n of the given async functions at a time; the rest wait in call order.
export function limiter(n) {

    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n || !queue.length) {
            return;
        }
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active--;
            next();
        });
    };

    return fn => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

// Concurrent calls with the same key share one promise; a call after it settled starts afresh.
export function dedupe() {

    const live = new Map();

    return (key, fn) => {
        if (!live.has(key)) {
            live.set(key, Promise.resolve().then(fn).finally(() => live.delete(key)));
        }

        return live.get(key);
    };
}

// Starts a refresh when the entry is stale and returns the entry ({ value, pending, error }) without waiting.
export function swrEntry(key, ttl, fn) {

    let hit = swr.get(key);
    if (!hit) {
        hit = { at: 0, value: null };
        swr.set(key, hit);
    }
    hit.fn = fn; // for refreshAll
    if (Date.now() - hit.at > ttl) {
        refetch(hit, fn);
    }

    return hit;
}

// Starts fn for a cache entry unless a fetch is already in flight, and returns that fetch. The old value keeps being
// served until the new one lands; a failure keeps it too and sets error.
export function refetch(hit, fn) {

    hit.pending ??= fn()
        .then(v => { hit.value = v; hit.error = null; hit.okAt = Date.now(); })
        .catch(e => { hit.error = e; })
        .finally(() => { hit.at = Date.now(); hit.pending = null; });

    return hit.pending;
}

// Manual refresh may start when none is running and the last one started at least gap ms ago.
export const refreshDue = (running, startedAt, now = Date.now(), gap = 5000) => !running && now - startedAt >= gap;

// The refresh button: every PR/MR state (but a merged one's) and every glab/gh cache entry (milestones, issues, linked MRs, me) refetches now
// through the limiter, never cleared. Issue groups go second so they are built from the fresh linked MRs.
// Concurrent calls share the running refresh; a call within 5 s of the last start returns at once.
let refreshRun = null, refreshStartedAt = 0, lastRefreshedAt = 0;
export function refreshAll() {

    if (!refreshDue(!!refreshRun, refreshStartedAt)) {
        return refreshRun ?? Promise.resolve();
    }
    refreshStartedAt = Date.now();
    const entries = [...swr];
    const isIssues = ([k]) => k.startsWith('issues:');
    const refetchAll = list => Promise.all(list.filter(([, hit]) => hit.fn).map(([, hit]) => refetch(hit, hit.fn)));
    refreshRun = Promise.all([
        ...[...prs].filter(([, hit]) => hit.value?.state !== 'merged').map(([url, hit]) => refetch(hit, () => apiSlot(() => fetchPr(url)))),
        refetchAll(entries.filter(e => !isIssues(e))).then(() => refetchAll(entries.filter(isIssues)))
    ]).finally(() => {
        refreshRun = null;
        lastRefreshedAt = Date.now();
    });

    return refreshRun;
}
export const refreshInfo = () => ({ refreshing: !!refreshRun, lastRefreshedAt });

// Stale-while-revalidate like prState, for any key. Only the first load waits; a failed first load throws.
export async function cached(key, ttl, fn) {

    const hit = swrEntry(key, ttl, fn);
    if (hit.value === null) {
        await hit.pending;
    }
    if (hit.value === null && hit.error) {
        throw hit.error;
    }

    return hit.value;
}

export const isGitLab = repo => repo.host.includes('gitlab');
// Every glab/gh call goes through one limiter, and an identical call already in flight is shared.
const API_PARALLEL = 8;
// ponytail: HOMEBASE_API_TIMEOUT_MS exists so the tests needn't wait a minute for a hung CLI
const apiTimeout = () => Number(process.env.HOMEBASE_API_TIMEOUT_MS) || 60_000;
const apiSlot = limiter(API_PARALLEL);
const apiOnce = dedupe();
export const api = (repo, path) => {

    const gitlab = isGitLab(repo);
    const call = () => (gitlab ? run('glab', ['api', path], { timeout: apiTimeout() }) : ghRun(repo, ['api', path], { timeout: apiTimeout() }));

    // the timeout kills a hung glab/gh, so it never holds a limiter slot for good; the account is part of the key
    return apiOnce(`${gitlab ? 'glab' : `gh:${accountOf(repo)}`} ${path}`, () => apiSlot(call)).then(({ stdout }) => JSON.parse(stdout));
};

// Every page of a list endpoint, 100 per page.
export async function pages(repo, path) {

    const out = [];
    for (let page = 1; ; page++) {
        const list = await api(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        out.push(...list);
        if (list.length < 100) {
            return out;
        }
    }
}

// { name, username } of a GitLab user or a GitHub login (GitHub's issue payload has no display name).
export const person = u => ({ name: u.name ?? u.login, username: u.username ?? u.login });
// The signed-in user of a repo's forge account: whoAmI throws when the lookup fails, signedIn answers null then. Cached
// 24 h per account and host; a failure is never cached, so the next call asks again.
const ME_TTL_MS = 24 * 3600_000;
export const me = new Map(); // account:host -> { at, value }
export async function whoAmI(repo) {

    const key = `${accountOf(repo)}:${repo.host}`;
    const hit = me.get(key);
    if (hit && Date.now() - hit.at < ME_TTL_MS) {
        return hit.value;
    }
    const value = person(await api(repo, 'user'));
    me.set(key, { at: Date.now(), value });

    return value;
}
export const signedIn = repo => whoAmI(repo).catch(() => null);

// Plain-text start of an issue description, about max chars, for the expanded card: HTML tags, markdown marks, links and headings dropped.
export function excerpt(md, max = 300) {

    const t = (md || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, ' ').replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^(#+\s|\|).*$/gm, ' ').replace(/[*`>#]+|__/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) {
        return t;
    }

    return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Unresolved human review threads on an open MR count as changes requested: GitLab reports not_approved, not
// discussions_not_resolved, while approval is also missing. So do general comments newer than my last note. Threads I
// answered last wait on the reviewer to resolve them, so when those are all that is open, the review is no longer on me.
export function withThreads(prState, comments) {

    if (prState?.state !== 'open' || !(comments?.unresolved || comments?.unanswered || comments?.replied)) {
        return prState;
    }
    if (!comments.unresolved && !comments.unanswered) {
        return { ...prState, changes: false, replied: comments.replied, repliedTo: comments.repliedTo };
    }

    const { unresolved, unresolvedBy, unanswered, unansweredBy } = comments;

    // also on an approved MR: comments nobody answered need an answer before it merges
    return { ...prState, changes: true, unresolved, unresolvedBy, unanswered, unansweredBy };
}

// Bots by flag (GitLab bot, GitHub type Bot) or name: GitHub's foo[bot], GitLab's project_1_bot_x tokens, *-bot / bot-*.
export const isBot = a => !!(a?.bot || a?.type === 'Bot' || /\[bot\]$|(^|[-_])bot($|[-_])/i.test(a?.username ?? ''));

// Comments by others than me and bots, newest first, at most max, with a plain-text excerpt. With threads
// ([{ resolved, notes: [{ author }] }], oldest note first), whose turn each unresolved one is: mine when another human
// wrote in it and I wrote its last human note (replied), else theirs (unresolved). Without, unresolved notes count.
// General comments (raw with general: true) by others after my newest note of any kind are unanswered.
export function humanComments(raw, me, max = 10, threads = null) {

    const human = a => a.username !== me && !isBot(a);
    const others = raw.filter(c => human(c.author) && c.body?.trim()).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const items = others.map(c => ({ id: c.id, author: c.author.name, at: c.at, excerpt: excerpt(c.body, 140), url: c.url, ...(c.resolved != null && { resolved: c.resolved }) }));

    const myLatest = Math.max(0, ...raw.filter(c => c.author.username === me).map(c => Date.parse(c.at)));
    const pending = others.filter(c => c.general && Date.parse(c.at) > myLatest);
    const shown = {
        latestAt: items[0]?.at ?? null, count: items.length, items: items.slice(0, max),
        unanswered: pending.length, unansweredBy: [...new Set(pending.map(c => c.author.name))]
    };
    if (!threads) {
        const open = items.filter(c => c.resolved === false);

        return { ...shown, unresolved: open.length, unresolvedBy: [...new Set(open.map(c => c.author))], replied: 0, repliedTo: [] };
    }

    // mine: I wrote its last note by a person, so I have replied; or its last note hands it to others with an @mention
    // (not me, not its writer), so it waits on them
    const byPerson = n => n.author.username === me || human(n.author);
    const handedTo = n => [...new Set([...(n.body ?? '').matchAll(/(?<![\w@.])@([\w.-]*\w)/g)].map(m => m[1]))]
        .filter(u => u !== me && u !== n.author.username);
    const turns = threads.filter(t => !t.resolved && t.notes.some(n => human(n.author))).map(t => {
        const last = t.notes.findLast(byPerson);
        const to = last.author.username === me ? [] : handedTo(last);

        return { mine: last.author.username === me || to.length > 0, by: to.length ? to : t.notes.filter(n => human(n.author)).map(n => n.author.name) };
    });
    const names = list => [...new Set(list.flatMap(t => t.by))];
    const open = turns.filter(t => !t.mine);
    const replied = turns.filter(t => t.mine);

    return { ...shown, unresolved: open.length, unresolvedBy: names(open), replied: replied.length, repliedTo: names(replied) };
}

// Read-only: one glab call per MR (discussions nest the notes; more pages only past 100 discussions), four gh calls per PR.
export async function fetchComments(url) {

    const gl = url.match(/^https:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
    const gh = url.match(/^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!gl && !gh) {
        return humanComments([], null); // neither GitLab nor GitHub
    }
    const repo = repoOfUrl(url);
    const me = (await whoAmI(repo)).username; // a failed lookup fails the comments: whose turn a thread is needs it
    const author = u => ({ ...person(u), bot: u.bot, type: u.type });

    if (gl) {
        const discussions = (await pages(repo, `projects/${encodeURIComponent(gl[2])}/merge_requests/${gl[3]}/discussions`))
            .map(d => d.notes.filter(n => !n.system).map(n => ({
                id: n.id, author: author(n.author), at: n.created_at, body: n.body, url: `${url}#note_${n.id}`, resolvable: n.resolvable, resolved: n.resolvable ? n.resolved : null, general: !n.resolvable
            }))).filter(notes => notes.length);
        const threads = discussions.filter(notes => notes[0].resolvable).map(notes => ({ resolved: notes.every(n => n.resolved), notes }));
        return humanComments(discussions.flat(), me, 10, threads);
    }

    // ponytail: first 100 of each list; a PR past that needs pages()
    const base = `repos/${gh[2]}`;
    const [issue, inline, reviews] = await Promise.all([`issues/${gh[3]}/comments`, `pulls/${gh[3]}/comments`, `pulls/${gh[3]}/reviews`]
        .map(p => api(repo, `${base}/${p}?per_page=100`)));
    const of = (c, at) => ({ id: c.id, author: author(c.user), at, body: c.body, url: c.html_url });
    const [owner, name] = gh[2].split('/');
    // ponytail: first 100 threads, last 50 comments each; review threads are only in GraphQL
    const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(last:50){nodes{body author{__typename login}}}}}}}}`;
    const args = ['api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${gh[3]}`];
    const toThread = t => ({
        resolved: t.isResolved, notes: t.comments.nodes.map(c => ({ body: c.body, author: { name: c.author?.login, username: c.author?.login, type: c.author?.__typename } }))
    });
    const threads = await apiOnce(`gh graphql threads ${url}`, () => apiSlot(() => ghRun(repo, args, { timeout: apiTimeout() })))
        .then(({ stdout }) => JSON.parse(stdout).data.repository.pullRequest.reviewThreads.nodes.map(toThread)); // a failure fails the comments: the last answer stays

    return humanComments([...issue.map(c => ({ ...of(c, c.created_at), general: true })), ...inline.map(c => of(c, c.created_at)), ...reviews.filter(r => r.submitted_at).map(r => of(r, r.submitted_at))], me, 10, threads);
}

export const OPEN_MRS_TTL_MS = 120_000;

// URLs of the signed-in user's open MRs (author or, on GitLab, assignee) or open PRs (author) in a project; read-only.
// ponytail: first 100 of each list, no paging
export async function openMrs(repo) {

    const me = await whoAmI(repo); // a failure is the entry's error (the board says so), never an empty list
    if (!isGitLab(repo)) {
        const q = encodeURIComponent(`repo:${repo.path} is:pr is:open author:${me.username}`);

        return (await api(repo, `search/issues?per_page=100&q=${q}`)).items.map(i => i.html_url);
    }
    const base = `projects/${encodeURIComponent(repo.path)}/merge_requests?state=opened&per_page=100`;
    const lists = await Promise.all(['author', 'assignee'].map(k => api(repo, `${base}&${k}_username=${me.username}`)));

    return [...new Set(lists.flat().map(m => m.web_url))];
}

// The cached open-MR URLs of a project; never waits, so the first poll after start may lack them.
export const openMrUrls = (project, repo) => swrEntry(`open:${project}`, OPEN_MRS_TTL_MS, () => openMrs(repo)).value ?? [];
