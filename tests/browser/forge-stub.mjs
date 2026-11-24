// Stands in for glab and gh: bin/glab and bin/gh in the fixture dir run `node forge-stub.mjs <cli> ...args`.
// Canned JSON per endpoint; anything unknown fails loudly and is logged, so a new server call shows up in the run.
import { appendFileSync } from 'node:fs';
import { PERSONAL_TOKEN, TRACKER_PR, OTHER_PR, OWNER } from './fixture.mjs';

const [cli, ...args] = process.argv.slice(2);
const log = line => process.env.HOMEBASE_STUB_LOG && appendFileSync(process.env.HOMEBASE_STUB_LOG, line + '\n');
const ago = s => new Date(Date.now() - s * 1000).toISOString();
const out = v => { log(`ok ${cli} ${args.join(' ')}`); process.stdout.write(JSON.stringify(v)); process.exit(0); };
const fail = msg => { log(`FAIL ${cli} ${args.join(' ')}`); process.stderr.write(msg + '\n'); process.exit(1); };

const GL = 'https://gitlab.com/acme/alpha';
const me = { username: 'tester', name: 'Test User' }, ann = { username: 'ann', name: 'Ann Reviewer' };
const sprint = { id: 11, title: 'Sprint 12', due_date: '2026-12-01' };
const mr = (iid, o) => ({ iid, state: 'opened', title: `MR ${iid}`, source_branch: `b-${iid}`, target_branch: 'main', description: '', reviewers: [], draft: false, milestone: sprint, web_url: `${GL}/-/merge_requests/${iid}`, author: me, ...o });
const MRS = {
    100: mr(100, { state: 'merged', title: '#8 - Cleanup', source_branch: '8-cleanup', detailed_merge_status: 'not_open', sha: 'aaa0000' }),
    101: mr(101, { title: '#5 - Fix login redirect', source_branch: '5-fix-login', detailed_merge_status: 'not_approved', head_pipeline: { status: 'failed', web_url: `${GL}/-/pipelines/1`, finished_at: ago(900) }, sha: 'aaa1111' }),
    102: mr(102, { title: 'Ship the audit log', source_branch: 'audit-log', detailed_merge_status: 'mergeable', head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/2`, finished_at: ago(600) }, sha: 'bbb2222abcdef' }),
    103: mr(103, { title: 'Add CSV export', source_branch: 'csv-export', detailed_merge_status: 'not_approved', reviewers: [ann], head_pipeline: { status: 'running', web_url: `${GL}/-/pipelines/3`, updated_at: ago(60) }, sha: 'ccc3333' }),
    104: mr(104, { title: 'Tune the cache TTL', source_branch: 'cache-ttl', detailed_merge_status: 'not_approved', reviewers: [ann], head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/4`, finished_at: ago(800) }, sha: 'eee5555' }),
    105: mr(105, { title: 'Credit note is not a payment', source_branch: '9-credit-note', detailed_merge_status: 'mergeable', head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/5`, finished_at: ago(700) }, sha: 'fff6666' }),
    106: mr(106, { title: 'Forge-only: never in a transcript', source_branch: 'forge-only', detailed_merge_status: 'not_approved', reviewers: [ann], head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/6`, finished_at: ago(500) }, sha: 'ggg7777' }),
    107: mr(107, { title: 'Stored-only: scrolled out of every tail', source_branch: 'stored-only', detailed_merge_status: 'not_approved', head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/7`, finished_at: ago(400) }, sha: 'hhh8888' })
};
// the user's open MRs as the list endpoint returns them: authored (the merged one is not open), plus one only assigned
const OPEN_AUTHORED = [101, 102, 103, 104, 106], OPEN_ASSIGNED = [102, 105];
MRS[201] = mr(201, { title: 'Refactor the tax lookup', author: ann, reviewers: [me], detailed_merge_status: 'not_approved', head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/9`, finished_at: ago(300) }, updated_at: ago(7200), references: { full: 'acme/alpha!201' } });
MRS[202] = mr(202, { title: 'Draft: new onboarding', author: ann, draft: true, reviewers: [me], detailed_merge_status: 'draft_status', updated_at: ago(86400 * 3), references: { full: 'acme/alpha!202' } });
// review requests: the instance-wide list (scope=all); my own MR 102 is in it and must be dropped
const REVIEW_REQUESTED = [201, 202, 102];
const DISCUSSIONS = {
    101: [{ notes: [{ id: 9001, system: false, author: ann, created_at: ago(3600), body: 'Please keep the **return URL** when redirecting.', resolvable: true, resolved: false }] }],
    104: [{ notes: [{ id: 9002, system: false, author: ann, created_at: ago(500), body: 'On your question about the TTL: I think it matters more than it looks.', resolvable: false }] }]
};
const issue = (iid, title, o = {}) => ({ iid, title, state: 'opened', assignees: [], web_url: `${GL}/-/issues/${iid}`, milestone: sprint, description: `Details for ${title}.`, updated_at: ago(7200), ...o });
const ISSUES = [
    issue(4, 'Sprint 12: Old thing', { state: 'closed', assignees: [ann] }),
    issue(5, 'Sprint 12: Fix login redirect', { assignees: [me] }),
    issue(6, 'Sprint 12: Add CSV export', { assignees: [ann] }),
    issue(7, 'Sprint 12: Dark mode', {}),
    issue(8, 'Sprint 12: Cleanup', { assignees: [me] }),
    issue(30, 'Sprint 12: Tidy docs', { assignees: [me] }) // mine, nothing started: the one with an enabled Start
];
const RELATED = {
    5: [MRS[101]],
    6: [],
    7: [],
    8: [MRS[100]]
};

function glab(path) {

    const [p] = path.split('?');
    if (p.includes('acme%2Fgamma')) {
        return fail('glab: 401 Unauthorized (fixture: gamma has no access)');
    }
    if (p === 'user') {
        return out(me);
    }
    if (p === 'merge_requests') {
        const q = new URLSearchParams(path.split('?')[1]);

        return q.get('reviewer_username') === 'tester' && q.get('scope') === 'all' ? out(REVIEW_REQUESTED.map(i => ({ ...MRS[i], ...(i === 102 && { reviewers: [me] }) }))) : fail(`stub: unexpected MR list ${path}`);
    }
    if (p === 'projects/acme%2Falpha/merge_requests') {
        const q = new URLSearchParams(path.split('?')[1]);
        const ids = q.get('state') === 'opened' && q.get('author_username') === 'tester' ? OPEN_AUTHORED : q.get('assignee_username') === 'tester' ? OPEN_ASSIGNED : null;

        return ids ? out(ids.map(i => MRS[i])) : fail(`stub: unexpected MR list ${path}`);
    }
    if (p === 'projects/acme%2Falpha/milestones') {
        return out([{ ...sprint, web_url: `${GL}/-/milestones/11`, group_id: null }, { id: 12, title: 'Backlog', due_date: null, web_url: `${GL}/-/milestones/12`, group_id: null }]);
    }
    if (p === 'projects/acme%2Falpha/issues_statistics') {
        return out({ statistics: { counts: { all: 5, closed: 1, opened: 4 } } });
    }
    if (p === 'projects/acme%2Falpha/milestones/11/issues') {
        return out(ISSUES);
    }
    if (p === 'projects/acme%2Falpha/issues') {
        const q = new URLSearchParams(path.split('?')[1]);

        return q.get('assignee_username') === 'tester' && q.get('state') === 'opened'
            ? out([ISSUES[1], ISSUES[4], issue(20, 'Backlog item for me', { assignees: [me], milestone: { id: 12, title: 'Backlog' } })])
            : fail(`stub: unexpected issue list ${path}`);
    }
    let m = p.match(/^projects\/acme%2Falpha\/issues\/(\d+)\/related_merge_requests$/);
    if (m) {
        return out(RELATED[m[1]] ?? []);
    }
    m = p.match(/^projects\/acme%2Falpha\/merge_requests\/(\d+)\/discussions$/);
    if (m) {
        return out(DISCUSSIONS[m[1]] ?? []);
    }
    m = p.match(/^projects\/acme%2Falpha\/merge_requests\/(\d+)$/);
    if (m && MRS[m[1]]) {
        return out(MRS[m[1]]);
    }

    return fail(`stub: no glab fixture for ${path}`);
}

// Personal repos answer only to the keychain token, and never to the work account's GITHUB_TOKEN, as on GitHub.
const personal = () => process.env.GH_TOKEN === PERSONAL_TOKEN && !process.env.GITHUB_TOKEN;
const trackerPr = { state: 'OPEN', title: 'Fix the tracker sync', body: '', reviewDecision: 'APPROVED', isDraft: false, headRefName: 'tracker-sync', baseRefName: 'main', milestone: null, reviewRequests: [], latestReviews: [], statusCheckRollup: [{ conclusion: 'SUCCESS', completedAt: ago(300) }], headRefOid: 'abc9999' };

function gh(rest) {

    if (rest.some(a => a.includes(`${OWNER}/`))) {
        if (!personal()) {
            return fail('gh: HTTP 404: Not Found (fixture: personal repo without the personal token)');
        }
        const url = rest.find(a => a.startsWith('https://'));
        if (rest[0] === 'pr' && url === TRACKER_PR) {
            return out(trackerPr);
        }
        if (rest[0] === 'pr' && url === OTHER_PR) {
            return out({ ...trackerPr, title: 'Homebase PR that must not show under tracker' });
        }
    }

    if (rest[0] === 'pr' && rest[1] === 'view' && rest[2] === 'https://github.com/acme/beta/pull/7') {
        return out({ state: 'OPEN', title: 'Add SQLite support', body: '', reviewDecision: 'REVIEW_REQUIRED', isDraft: false, headRefName: 'sqlite', baseRefName: 'main', milestone: null, reviewRequests: [], latestReviews: [], statusCheckRollup: [{ conclusion: 'SUCCESS', completedAt: ago(300) }], headRefOid: 'ddd4444' });
    }
    if (rest[0] !== 'api') {
        return fail(`stub: no gh fixture for ${rest.join(' ')}`);
    }
    if (rest[1] === 'graphql') {
        return out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    const [p] = rest[1].split('?');
    if (p === 'user') {
        return out({ login: personal() ? OWNER : 'tester', type: 'User' });
    }
    if (p === 'search/issues') {
        return out({ items: rest[1].includes(OWNER) ? [] : [{ html_url: 'https://github.com/acme/beta/pull/7' }] });
    }
    if (p === 'repos/acme/beta/milestones' || (p === `repos/${OWNER}/tracker/milestones` && personal())) {
        return out([]);
    }
    // beta has no milestones: its Issues tab lists my open issues, #3 linked to PR 7 by its closing keyword
    if (p === 'repos/acme/beta/issues') {
        const gi = (number, title) => ({ number, title, state: 'open', assignees: [{ login: 'tester' }], html_url: `https://github.com/acme/beta/issues/${number}`, milestone: null, body: `Details for ${title}.`, updated_at: ago(7200) });

        return out([gi(3, 'Add SQLite support'), gi(4, 'Document the config')]);
    }
    if (p === 'repos/acme/beta/pulls') {
        return out([{ number: 7, html_url: 'https://github.com/acme/beta/pull/7', state: 'open', merged_at: null, title: 'Add SQLite support', body: 'Closes #3', head: { ref: 'sqlite' }, user: { login: 'tester' } }]);
    }
    if (new RegExp(`^repos/${OWNER}/tracker/(issues|pulls)$`).test(p) && personal()) {
        return out([]);
    }
    if (new RegExp(`^repos/${OWNER}/tracker/(issues|pulls)/32/(comments|reviews)$`).test(p) && personal()) {
        return out([]);
    }
    if (/^repos\/acme\/beta\/(issues|pulls)\/7\/(comments|reviews)$/.test(p)) {
        return out([]);
    }

    return fail(`stub: no gh fixture for ${rest.join(' ')}`);
}

if (cli === 'glab' && args[0] === 'api') {
    glab(args[1]);
} else if (cli === 'gh') {
    gh(args);
} else {
    fail(`stub: unsupported ${cli} ${args.join(' ')}`);
}
