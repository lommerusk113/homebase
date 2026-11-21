// Milestones tab: open milestones, their issue groups and linked MRs, cached per project, warmed at start.
import { api, pages, cached, swrEntry, swr, prs, isGitLab, person, signedIn, excerpt, pipelineOf, problemText, forgeWords } from './forge.mjs';
import { sameRepo, milestoneOf } from './items.mjs';
import { sessions, repoPaths } from './sessions.mjs';

// Milestones: read-only glab/gh calls, cached per project, per milestone's issue list and per open issue's linked MRs.
const MS_LIST_TTL_MS = 5 * 60_000;
const MS_ISSUES_TTL_MS = 90_000;
const MS_LINKS_TTL_MS = 5 * 60_000;
const MS_FIRST_LOAD_MS = 15_000; // a project's first milestone list answers by then, as still loading if it is not in yet

// Open milestones with their issue counts (closed/total) for the selector menu.
async function fetchMilestones(repo) {

    if (isGitLab(repo)) {
        const p = encodeURIComponent(repo.path);
        const list = await api(repo, `projects/${p}/milestones?state=active&include_ancestors=true&per_page=100`);
        // ponytail: counts by title, so a same-titled group milestone would add to them; exact counts need each milestone's issue list
        return Promise.all(list.map(async m => {
            const c = (await api(repo, `projects/${p}/issues_statistics?milestone=${encodeURIComponent(m.title)}`).catch(() => null))?.statistics?.counts;
            return { id: m.id, title: m.title, due: m.due_date ?? null, url: m.web_url, group: !!m.group_id, closed: c?.closed ?? null, total: c?.all ?? null };
        }));
    }
    const list = await api(repo, `repos/${repo.path}/milestones?state=open&per_page=100`);

    return list.map(m => ({ id: m.number, title: m.title, due: m.due_on?.slice(0, 10) ?? null, url: m.html_url, closed: m.closed_issues, total: m.open_issues + m.closed_issues }));
}

// Only issues whose own milestone is the selected one; the API's milestone filter is not trusted on its own.
export const keepMilestone = (issues, id) => issues.filter(i => i.milestone === id);

// The API's issue payloads as the issue rows the front end draws; milestoneTitle shows on the "Assigned to me" rows.
const glIssue = i => ({ iid: i.iid, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', assignees: (i.assignees ?? []).map(person), url: i.web_url, milestone: i.milestone?.id, milestoneTitle: i.milestone?.title, desc: excerpt(i.description), updated: i.updated_at });
const ghIssue = i => ({ iid: i.number, title: i.title, state: i.state, assignees: (i.assignees ?? []).map(person), url: i.html_url, milestone: i.milestone?.number, milestoneTitle: i.milestone?.title, desc: excerpt(i.body), updated: i.updated_at });

async function fetchIssues(repo, ms) {

    if (isGitLab(repo)) {
        const p = encodeURIComponent(repo.path);
        // a project milestone by id; a group milestone has no project-scoped endpoint, so by title, then filtered by id
        const path = ms.group ? `projects/${p}/issues?milestone=${encodeURIComponent(ms.title)}&state=all` : `projects/${p}/milestones/${ms.id}/issues`;
        return keepMilestone((await pages(repo, path)).map(glIssue), ms.id);
    }
    const list = (await pages(repo, `repos/${repo.path}/issues?milestone=${ms.id}&state=all`)).filter(i => !i.pull_request).map(ghIssue);

    return keepMilestone(list, ms.id);
}

// The user's open issues across all milestones.
async function fetchMine(repo, me) {

    if (isGitLab(repo)) {
        return (await pages(repo, `projects/${encodeURIComponent(repo.path)}/issues?assignee_username=${encodeURIComponent(me.username)}&state=opened`)).map(glIssue);
    }

    return (await pages(repo, `repos/${repo.path}/issues?assignee=${encodeURIComponent(me.username)}&state=open`)).filter(i => !i.pull_request).map(ghIssue);
}

// An MR works on an issue when its title or source branch names the issue number ("#2223 - …", "2223-fix-…").
// related_merge_requests also returns MRs that only mention the issue in a description or comment.
export const worksOn = (mr, iid) => new RegExp(`(^|\\D)${iid}(\\D|$)`).test(`${mr.title} ${mr.source_branch}`);

// ponytail: GitHub's linked PRs need GraphQL, so GitHub issues are never "in progress" or "can be closed"
async function fetchLinks(repo, iid) {

    const list = await api(repo, `projects/${encodeURIComponent(repo.path)}/issues/${iid}/related_merge_requests`);

    // the author is who works on it, for in-progress issues nobody is assigned to; the payload carries the pipeline too
    return list.filter(m => worksOn(m, iid)).map(m => ({
        iid: m.iid, url: m.web_url, state: { opened: 'open' }[m.state] ?? m.state,
        author: m.author ? person(m.author) : null, pipeline: pipelineOf(m.head_pipeline ?? m.pipeline)
    }));
}

// Issues of a milestone in the order the user acts on them. links: iid -> [{ state: open|merged|closed }] for open issues.
// An open MR wins over a merged one: a follow-up still in review means the issue isn't done.
export function groupIssues(issues, links = {}) {

    const groups = { closable: [], doing: [], assigned: [], unassigned: [], done: [] };
    for (const i of issues) {
        const mrs = links[i.iid] ?? [];
        const key = i.state === 'closed' ? 'done'
            : mrs.some(m => m.state === 'open') ? 'doing'
            : mrs.some(m => m.state === 'merged') ? 'closable'
            : i.assignees.length ? 'assigned' : 'unassigned';
        groups[key].push({ ...i, mrs });
    }

    return { total: issues.length, closed: groups.done.length, groups };
}

// Ids of listed milestones that the board's MRs belong to, open MRs weighing most.
export function activeMilestones(mrs, list) {

    const score = new Map();
    for (const mr of mrs) {
        const id = milestoneOf(mr, list)?.id;
        if (list.some(m => m.id === id)) {
            score.set(id, (score.get(id) ?? 0) + (mr.state === 'open' ? 10 : 1));
        }
    }

    return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// The issue groups of one milestone; its open issues' MRs in parallel (api's limiter bounds them).
async function milestoneIssues(project, repo, load) {

    const issues = await load();
    const links = {};
    if (isGitLab(repo)) {
        await Promise.all(issues.filter(i => i.state === 'open').map(async ({ iid }) => {
            links[iid] = await cached(`links:${project}:${iid}`, MS_LINKS_TTL_MS, () => fetchLinks(repo, iid)).catch(() => []);
        }));
    }

    return groupIssues(issues, links);
}

// A project's open milestones, the ids its MRs point at, and the issue groups of the chosen one.
// pick: a milestone id (or a title, as older saved choices hold), "none" for no milestone, "mine" for the open issues
// assigned to the signed-in user in every milestone (works without milestones too), empty for the most active one.
export async function milestones(project, pick) {

    // right after start the projects come from the warm-up's session scan
    if (!repoPaths.has(project)) {
        await scanned;
    }
    const repo = repoPaths.get(project);
    if (!repo) {
        throw Object.assign(new Error('unknown project'), { status: 404, body: noMilestones(project, null, 'unsupported', 'unknown project') });
    }

    // the signed-in user, for the Issues tab's "you" lane; a failed lookup only loses the mark
    const late = new Promise((_, fail) => setTimeout(() => fail(STILL_LOADING), MS_FIRST_LOAD_MS).unref());
    const w = forgeWords(project);
    let list, me;
    try {
        [list, me] = await Promise.race([late, Promise.all([
            cached(`ms:${project}`, MS_LIST_TTL_MS, () => fetchMilestones(repo)),
            signedIn(repo)
        ])]);
    } catch (e) {
        // a slow forge is no error: the calls go on in the background and the page keeps asking (the CLI's own timeout ends a hung one)
        return e === STILL_LOADING ? { ...noMilestones(project, repo, null), loading: true } : noMilestones(project, repo, 'error', problemText(e, w.cli));
    }
    if (pick === 'mine') {
        return mineView(project, repo, list, me);
    }
    if (!list.length) {
        return { ...noMilestones(project, repo, 'none'), me };
    }
    const mrs = [...prs].filter(([url, hit]) => hit.value && sameRepo(url, project)).map(([, hit]) => hit.value);
    const detected = activeMilestones(mrs, list);
    const ms = pick === 'none' ? null : list.find(m => String(m.id) === pick || m.title === pick) ?? list.find(m => m.id === detected[0]);

    // the issue groups never wait: until the first load is in, selected has the list's counts and loading: true
    const issues = ms && swrEntry(`issues:${project}:${ms.id}`, MS_ISSUES_TTL_MS, () => milestoneIssues(project, repo, () => fetchIssues(repo, ms)));
    const selected = !ms ? null : issues.value ? { ...ms, ...issues.value } : { ...ms, loading: !!issues.pending, error: problemText(issues.error, w.cli) };
    const updating = !!(issues?.pending || swr.get(`ms:${project}`).pending);

    return { project, forge: w.forge, milestones: list, detected, me, selected, updating, loading: false, reason: null, url: milestonesPage(repo) };
}

// The "Assigned to me" pseudo-milestone: id "mine", no due date, the user's open issues from every milestone.
export function mineView(project, repo, list, me) {

    const w = forgeWords(project);
    const base = { id: 'mine', title: 'Assigned to me', due: null, url: milestonesPage(repo).replace(/milestones$/, 'issues'), group: false, closed: 0, total: null, mine: true };
    if (!me) {
        return { project, forge: w.forge, milestones: list, detected: [], me, selected: { ...base, error: 'could not tell who you are on this forge' }, updating: false, loading: false, reason: null, url: milestonesPage(repo) };
    }
    const issues = swrEntry(`issues:${project}:mine`, MS_ISSUES_TTL_MS, () => milestoneIssues(project, repo, () => fetchMine(repo, me)));
    const selected = issues.value ? { ...base, ...issues.value } : { ...base, loading: !!issues.pending, error: problemText(issues.error, w.cli) };

    return { project, forge: w.forge, milestones: list, detected: [], me, selected, updating: !!(issues.pending || swr.get(`ms:${project}`).pending), loading: false, reason: null, url: milestonesPage(repo) };
}

const milestonesPage = repo => (isGitLab(repo) ? `https://${repo.host}/${repo.path}/-/milestones` : `https://github.com/${repo.path}/milestones`);

// The terminal answer for a project without milestones to show. reason: none (it has no open ones), error (glab/gh
// failed; error says why in plain words), unsupported (a project the session scan does not know).
export function noMilestones(project, repo, reason, error = null) {
    return {
        project, forge: forgeWords(project).forge, milestones: [], detected: [], me: null, selected: null, updating: false, loading: false, reason, error,
        url: reason !== 'unsupported' && repo ? milestonesPage(repo) : null
    };
}

const STILL_LOADING = new Error('still loading the milestones');

// Session scan at start, so /api/milestones knows the projects and the board's MRs before the page asks.
let scanned = Promise.resolve();

// Fills the milestone caches in the background for every project seen in recent sessions: the list, and the issues of its most active milestone.
// ponytail: only the detected milestone's issues; another one loads on first pick (counts show at once, issues follow)
export function warmMilestones() {

    scanned = sessions().catch(() => {});
    scanned.then(() => Promise.all([...repoPaths.keys()].map(p => milestones(p, '').catch(() => {}))));
}
