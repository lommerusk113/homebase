// Milestones tab: open milestones, their issue groups and linked MRs, cached per project, warmed at start.
import { api, pages, cached, swrEntry, swr, prs, isGitLab, person, signedIn, excerpt, pipelineOf } from './forge.mjs';
import { sameRepo, milestoneOf } from './items.mjs';
import { sessions, repoPaths } from './sessions.mjs';

// Milestones: read-only glab/gh calls, cached per project, per milestone's issue list and per open issue's linked MRs.
const MS_LIST_TTL_MS = 5 * 60_000;
const MS_ISSUES_TTL_MS = 90_000;
const MS_LINKS_TTL_MS = 5 * 60_000;
const MS_FIRST_LOAD_MS = 15_000; // a project's first milestone list answers by then, as an error if it is not in yet

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

async function fetchIssues(repo, ms) {

    if (isGitLab(repo)) {
        const p = encodeURIComponent(repo.path);
        // a project milestone by id; a group milestone has no project-scoped endpoint, so by title, then filtered by id
        const path = ms.group ? `projects/${p}/issues?milestone=${encodeURIComponent(ms.title)}&state=all` : `projects/${p}/milestones/${ms.id}/issues`;
        const list = (await pages(repo, path)).map(i => ({ iid: i.iid, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', assignees: (i.assignees ?? []).map(person), url: i.web_url, milestone: i.milestone?.id, desc: excerpt(i.description), updated: i.updated_at }));
        return keepMilestone(list, ms.id);
    }
    const list = (await pages(repo, `repos/${repo.path}/issues?milestone=${ms.id}&state=all`)).filter(i => !i.pull_request)
        .map(i => ({ iid: i.number, title: i.title, state: i.state, assignees: (i.assignees ?? []).map(person), url: i.html_url, milestone: i.milestone?.number, desc: excerpt(i.body), updated: i.updated_at }));

    return keepMilestone(list, ms.id);
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
async function milestoneIssues(project, repo, ms) {

    const issues = await fetchIssues(repo, ms);
    const links = {};
    if (isGitLab(repo)) {
        await Promise.all(issues.filter(i => i.state === 'open').map(async ({ iid }) => {
            links[iid] = await cached(`links:${project}:${iid}`, MS_LINKS_TTL_MS, () => fetchLinks(repo, iid)).catch(() => []);
        }));
    }

    return groupIssues(issues, links);
}

// A project's open milestones, the ids its MRs point at, and the issue groups of the chosen one.
// pick: a milestone id (or a title, as older saved choices hold), "none" for no milestone, empty for the most active one.
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
    const late = new Promise((_, fail) => setTimeout(() => fail(new Error('timed out loading the milestones')), MS_FIRST_LOAD_MS).unref());
    let list, me;
    try {
        [list, me] = await Promise.race([late, Promise.all([
            cached(`ms:${project}`, MS_LIST_TTL_MS, () => fetchMilestones(repo)),
            signedIn(repo)
        ])]);
    } catch (e) {
        return noMilestones(project, repo, 'error', e.stderr?.trim() || e.message);
    }
    if (!list.length) {
        return { ...noMilestones(project, repo, 'none'), me };
    }
    const mrs = [...prs].filter(([url, hit]) => hit.value && sameRepo(url, project)).map(([, hit]) => hit.value);
    const detected = activeMilestones(mrs, list);
    const ms = pick === 'none' ? null : list.find(m => String(m.id) === pick || m.title === pick) ?? list.find(m => m.id === detected[0]);

    // the issue groups never wait: until the first load is in, selected has the list's counts and loading: true
    const issues = ms && swrEntry(`issues:${project}:${ms.id}`, MS_ISSUES_TTL_MS, () => milestoneIssues(project, repo, ms));
    const selected = !ms ? null : issues.value ? { ...ms, ...issues.value } : { ...ms, loading: !!issues.pending, error: issues.error?.message ?? null };
    const updating = !!(issues?.pending || swr.get(`ms:${project}`).pending);

    return { project, milestones: list, detected, me, selected, updating, loading: false, reason: null, url: milestonesPage(repo) };
}

const milestonesPage = repo => (isGitLab(repo) ? `https://${repo.host}/${repo.path}/-/milestones` : `https://github.com/${repo.path}/milestones`);

// The terminal answer for a project without milestones to show. reason: none (it has no open ones), error (glab/gh
// failed or timed out; error says why), unsupported (a project the session scan does not know).
export function noMilestones(project, repo, reason, error = null) {
    return {
        project, milestones: [], detected: [], me: null, selected: null, updating: false, loading: false, reason, error,
        url: reason !== 'unsupported' && repo ? milestonesPage(repo) : null
    };
}

// Session scan at start, so /api/milestones knows the projects and the board's MRs before the page asks.
let scanned = Promise.resolve();

// Fills the milestone caches in the background for every project seen in recent sessions: the list, and the issues of its most active milestone.
// ponytail: only the detected milestone's issues; another one loads on first pick (counts show at once, issues follow)
export function warmMilestones() {

    scanned = sessions().catch(() => {});
    scanned.then(() => Promise.all([...repoPaths.keys()].map(p => milestones(p, '').catch(() => {}))));
}
