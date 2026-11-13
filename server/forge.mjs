// GitLab/GitHub via glab/gh (read-only): PR/MR state, review comments and threads, the shared limiter and dedupe,
// the stale-while-revalidate caches (prs, swr) and the refresh button.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const PR_TTL_MS = 60_000;
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

// The coarse ci flag nextStep/rowAction read: 'failing', 'running' or null.
export const ciOf = pipeline => ({ failed: 'failing', running: 'running', pending: 'running' })[pipeline?.status] ?? null;

// Read-only PR/MR lookup via gh/glab. Returns { state: open|merged|closed, title, branch, reviewers, ready, changes, changesBy, draft, ci, pipeline } or null.
async function fetchPr(url) {

    const gl = url.match(/^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (gl) {
        const { stdout } = await run('glab', ['api', `projects/${encodeURIComponent(gl[1])}/merge_requests/${gl[2]}`]);
        const mr = JSON.parse(stdout);
        const state = { opened: 'open', merged: 'merged' }[mr.state] ?? 'closed';
        const status = mr.detailed_merge_status;
        const pipeline = pipelineOf(mr.head_pipeline ?? mr.pipeline);

        return {
            state,
            title: mr.title,
            branch: mr.source_branch,
            reviewers: (mr.reviewers ?? []).map(r => r.name),
            ready: status === 'mergeable',
            // ponytail: the MR payload doesn't say which reviewer blocked; the /reviewers endpoint would
            changes: status === 'requested_changes' || status === 'discussions_not_resolved' || mr.blocking_discussions_resolved === false,
            changesBy: [],
            draft: !!mr.draft,
            ci: { ci_must_pass: 'failing', ci_still_running: 'running' }[status] ?? ciOf(pipeline),
            pipeline,
            milestone: mr.milestone ? { id: mr.milestone.id, title: mr.milestone.title, due_date: mr.milestone.due_date } : null,
            target: mr.target_branch,
            issue: issueOf(mr.title, mr.description),
            sha: mr.sha ?? mr.diff_refs?.head_sha ?? null
        };
    }

    const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state,title,body,reviewDecision,isDraft,headRefName,baseRefName,milestone,reviewRequests,latestReviews,statusCheckRollup,headRefOid']);
    const pr = JSON.parse(stdout);
    const pipeline = pipelineOf(null, pr.statusCheckRollup, url);
    const reviews = pr.latestReviews ?? [];

    return {
        state: pr.state.toLowerCase(),
        title: pr.title,
        branch: pr.headRefName,
        reviewers: [...new Set([...(pr.reviewRequests ?? []).map(r => r.login ?? r.name), ...reviews.map(r => r.author?.login)].filter(Boolean))],
        ready: pr.reviewDecision === 'APPROVED' && !pr.isDraft,
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

    const n = url.match(/(?:merge_requests|pull)\/(\d+)/)?.[1];
    const ref = r => new RegExp(`(?<![\\w&!#])${r}(?!\\d)`).test(text);

    return !!((n && ref(`${url.includes('/pull/') ? '#' : '!'}${n}`)) || (issue && ref(`#${issue}`)));
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
    if (Date.now() - hit.at > PR_TTL_MS) {
        refetch(hit, () => fetchPr(url));
    }
    if (!hit.at) {
        await hit.pending;
    }

    return hit.value;
}

const MS_PARALLEL = 8;
const MS_CALL_TIMEOUT_MS = 60_000;
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
export function refresh(key, ttl, fn) {

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
        .then(v => { hit.value = v; hit.error = null; })
        .catch(e => { hit.error = e; })
        .finally(() => { hit.at = Date.now(); hit.pending = null; });

    return hit.pending;
}

// Manual refresh may start when none is running and the last one started at least gap ms ago.
export const refreshDue = (running, startedAt, now = Date.now(), gap = 5000) => !running && now - startedAt >= gap;

// The refresh button: every PR/MR state and every glab/gh cache entry (milestones, issues, linked MRs, me) refetches now
// through the limiter, never cleared. Issue groups go second so they are built from the fresh linked MRs.
// Concurrent calls share the running refresh; a call within 5 s of the last start returns at once.
let refreshRun = null, refreshStartedAt = 0, lastRefreshedAt = 0;
export function refreshAll() {

    if (!refreshDue(!!refreshRun, refreshStartedAt)) {
        return refreshRun ?? Promise.resolve();
    }
    refreshStartedAt = Date.now();
    const entries = [...swr];
    const again = issues => Promise.all(entries.filter(([k, hit]) => hit.fn && k.startsWith('issues:') === issues).map(([, hit]) => refetch(hit, hit.fn)));
    refreshRun = Promise.all([
        ...[...prs].map(([url, hit]) => refetch(hit, () => apiSlot(() => fetchPr(url)))),
        again(false).then(() => again(true))
    ]).finally(() => { refreshRun = null; lastRefreshedAt = Date.now(); });

    return refreshRun;
}
export const refreshInfo = () => ({ refreshing: !!refreshRun, lastRefreshedAt });

// Stale-while-revalidate like prState, for any key. Only the first load waits; a failed first load throws.
export async function cached(key, ttl, fn) {

    const hit = refresh(key, ttl, fn);
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
export const apiSlot = limiter(MS_PARALLEL);
const apiOnce = dedupe();
export const api = (repo, path) => {

    const cli = isGitLab(repo) ? 'glab' : 'gh';

    // the timeout kills a hung glab/gh, so it never holds a limiter slot for good
    return apiOnce(`${cli} ${path}`, () => apiSlot(() => run(cli, ['api', path], { timeout: MS_CALL_TIMEOUT_MS }))).then(({ stdout }) => JSON.parse(stdout));
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

// Plain-text start of an issue description, about max chars, for the expanded card: markdown marks, links and headings dropped.
export function excerpt(md, max = 300) {

    const t = (md || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^(#+\s|\|).*$/gm, ' ').replace(/[*`>#]+|__/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) {
        return t;
    }

    return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

// Unresolved human review threads on an open MR count as changes requested: GitLab reports not_approved, not
// discussions_not_resolved, while approval is also missing. Threads I answered last wait on the reviewer to resolve
// them, so when those are all that is open, the review is no longer on me.
export function withThreads(prState, comments) {

    if (prState?.state !== 'open' || !(comments?.unresolved || comments?.replied)) {
        return prState;
    }
    if (!comments.unresolved) {
        return { ...prState, changes: false, replied: comments.replied, repliedTo: comments.repliedTo };
    }

    return { ...prState, changes: true, unresolved: comments.unresolved, unresolvedBy: comments.unresolvedBy };
}

// Bots by flag (GitLab bot, GitHub type Bot) or name: GitHub's foo[bot], GitLab's project_1_bot_x tokens, *-bot / bot-*.
export const isBot = a => !!(a?.bot || a?.type === 'Bot' || /\[bot\]$|(^|[-_])bot($|[-_])/i.test(a?.username ?? ''));

// Comments by others than me and bots, newest first, at most max, with a plain-text excerpt. With threads
// ([{ resolved, notes: [{ author }] }], oldest note first), whose turn each unresolved one is: mine when another human
// wrote in it and I wrote its last human note (replied), else theirs (unresolved). Without, unresolved notes count.
export function humanComments(raw, me, max = 10, threads = null) {

    const human = a => a.username !== me && !isBot(a);
    const items = raw.filter(c => human(c.author) && c.body?.trim())
        .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
        .map(c => ({ id: c.id, author: c.author.name, at: c.at, excerpt: excerpt(c.body, 140), url: c.url, ...(c.resolved != null && { resolved: c.resolved }) }));

    if (!threads) {
        const open = items.filter(c => c.resolved === false);
        return { latestAt: items[0]?.at ?? null, count: items.length, items: items.slice(0, max), unresolved: open.length, unresolvedBy: [...new Set(open.map(c => c.author))], replied: 0, repliedTo: [] };
    }

    const turns = threads.filter(t => !t.resolved && t.notes.some(n => human(n.author)))
        .map(t => ({ mine: t.notes.findLast(n => n.author.username === me || human(n.author)).author.username === me, by: t.notes.filter(n => human(n.author)).map(n => n.author.name) }));
    const names = list => [...new Set(list.flatMap(t => t.by))];
    const open = turns.filter(t => !t.mine);
    const replied = turns.filter(t => t.mine);

    return { latestAt: items[0]?.at ?? null, count: items.length, items: items.slice(0, max), unresolved: open.length, unresolvedBy: names(open), replied: replied.length, repliedTo: names(replied) };
}

// Read-only: one glab call per MR (discussions nest the notes; more pages only past 100 discussions), four gh calls per PR.
export async function fetchComments(url) {

    const gl = url.match(/^https:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/);
    const gh = url.match(/^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    if (!gl && !gh) {
        return humanComments([], null); // neither GitLab nor GitHub
    }
    const repo = { host: (gl ?? gh)[1] };
    const me = (await cached(`me:${repo.host}`, 24 * 3600_000, () => api(repo, 'user').then(person)).catch(() => null))?.username;
    const author = u => ({ ...person(u), bot: u.bot, type: u.type });

    if (gl) {
        const discussions = (await pages(repo, `projects/${encodeURIComponent(gl[2])}/merge_requests/${gl[3]}/discussions`))
            .map(d => d.notes.filter(n => !n.system).map(n => ({
                id: n.id, author: author(n.author), at: n.created_at, body: n.body, url: `${url}#note_${n.id}`, resolvable: n.resolvable, resolved: n.resolvable ? n.resolved : null
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
    const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(last:50){nodes{author{__typename login}}}}}}}}`;
    const threads = await apiOnce(`gh graphql threads ${url}`, () => apiSlot(() => run('gh', ['api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${gh[3]}`], { timeout: MS_CALL_TIMEOUT_MS })))
        .then(({ stdout }) => JSON.parse(stdout).data.repository.pullRequest.reviewThreads.nodes.map(t => ({
            resolved: t.isResolved, notes: t.comments.nodes.map(c => ({ author: { name: c.author?.login, username: c.author?.login, type: c.author?.__typename } }))
        }))).catch(() => null);

    return humanComments([...issue.map(c => of(c, c.created_at)), ...inline.map(c => of(c, c.created_at)), ...reviews.filter(r => r.submitted_at).map(r => of(r, r.submitted_at))], me, 10, threads);
}
