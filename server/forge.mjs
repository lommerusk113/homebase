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

// The MR/PR number in its URL, as a string.
export const mrNumber = url => url.match(/(?:merge_requests|pull)\/(\d+)/)?.[1];
// How people write the MR/PR in text: !12 on GitLab, #12 on GitHub.
export const mrRef = url => `${url.includes('/pull/') ? '#' : '!'}${mrNumber(url)}`;
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

    const ref = r => new RegExp(`(?<![\\w&!#])${r}(?!\\d)`).test(text);

    return !!((mrNumber(url) && ref(mrRef(url))) || (issue && ref(`#${issue}`)));
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
    const isIssues = ([k]) => k.startsWith('issues:');
    const refetchAll = list => Promise.all(list.filter(([, hit]) => hit.fn).map(([, hit]) => refetch(hit, hit.fn)));
    refreshRun = Promise.all([
        ...[...prs].map(([url, hit]) => refetch(hit, () => apiSlot(() => fetchPr(url)))),
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
const API_CALL_TIMEOUT_MS = 60_000;
const apiSlot = limiter(API_PARALLEL);
const apiOnce = dedupe();
export const api = (repo, path) => {

    const cli = isGitLab(repo) ? 'glab' : 'gh';

    // the timeout kills a hung glab/gh, so it never holds a limiter slot for good
    return apiOnce(`${cli} ${path}`, () => apiSlot(() => run(cli, ['api', path], { timeout: API_CALL_TIMEOUT_MS }))).then(({ stdout }) => JSON.parse(stdout));
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
// The signed-in user of a forge host, or null when the lookup fails.
export const signedIn = repo => cached(`me:${repo.host}`, 24 * 3600_000, () => api(repo, 'user').then(person)).catch(() => null);

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

    // mine: I wrote its last note by a person, so I have replied
    const byPerson = n => n.author.username === me || human(n.author);
    const turns = threads.filter(t => !t.resolved && t.notes.some(n => human(n.author)))
        .map(t => ({ mine: t.notes.findLast(byPerson).author.username === me, by: t.notes.filter(n => human(n.author)).map(n => n.author.name) }));
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
    const repo = { host: (gl ?? gh)[1] };
    const me = (await signedIn(repo))?.username;
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
    const q = `query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){reviewThreads(first:100){nodes{isResolved comments(last:50){nodes{author{__typename login}}}}}}}}`;
    const args = ['api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `n=${name}`, '-F', `p=${gh[3]}`];
    const toThread = t => ({
        resolved: t.isResolved, notes: t.comments.nodes.map(c => ({ author: { name: c.author?.login, username: c.author?.login, type: c.author?.__typename } }))
    });
    const threads = await apiOnce(`gh graphql threads ${url}`, () => apiSlot(() => run('gh', args, { timeout: API_CALL_TIMEOUT_MS })))
        .then(({ stdout }) => JSON.parse(stdout).data.repository.pullRequest.reviewThreads.nodes.map(toThread))
        .catch(() => null);

    return humanComments([...issue.map(c => ({ ...of(c, c.created_at), general: true })), ...inline.map(c => of(c, c.created_at)), ...reviews.filter(r => r.submitted_at).map(r => of(r, r.submitted_at))], me, 10, threads);
}

export const OPEN_MRS_TTL_MS = 120_000;

// URLs of the signed-in user's open MRs (author or, on GitLab, assignee) or open PRs (author) in a project; read-only.
// ponytail: first 100 of each list, no paging
export async function openMrs(repo) {

    const me = await signedIn(repo);
    if (!me) {
        return [];
    }
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
