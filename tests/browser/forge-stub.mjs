// Stands in for glab and gh: bin/glab and bin/gh in the fixture dir run `node forge-stub.mjs <cli> ...args`.
// Canned JSON per endpoint; anything unknown fails loudly and is logged, so a new server call shows up in the run.
import { appendFileSync } from 'node:fs';

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
    103: mr(103, { title: 'Add CSV export', source_branch: '6-export', detailed_merge_status: 'not_approved', reviewers: [ann], head_pipeline: { status: 'running', web_url: `${GL}/-/pipelines/3`, updated_at: ago(60) }, sha: 'ccc3333' }),
    104: mr(104, { title: 'Tune the cache TTL', source_branch: 'cache-ttl', detailed_merge_status: 'not_approved', reviewers: [ann], head_pipeline: { status: 'success', web_url: `${GL}/-/pipelines/4`, finished_at: ago(800) }, sha: 'eee5555' })
};
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
    issue(8, 'Sprint 12: Cleanup', { assignees: [me] })
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
    if (p === 'projects/acme%2Falpha/milestones') {
        return out([{ ...sprint, web_url: `${GL}/-/milestones/11`, group_id: null }]);
    }
    if (p === 'projects/acme%2Falpha/issues_statistics') {
        return out({ statistics: { counts: { all: 5, closed: 1, opened: 4 } } });
    }
    if (p === 'projects/acme%2Falpha/milestones/11/issues') {
        return out(ISSUES);
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

function gh(rest) {

    if (rest[0] === 'pr' && rest[1] === 'view' && rest[2] === 'https://github.com/acme/beta/pull/7') {
        return out({ state: 'OPEN', title: 'Add SQLite support', body: '', reviewDecision: '', isDraft: false, headRefName: 'sqlite', baseRefName: 'main', milestone: null, reviewRequests: [], latestReviews: [], statusCheckRollup: [{ conclusion: 'SUCCESS', completedAt: ago(300) }], headRefOid: 'ddd4444' });
    }
    if (rest[0] !== 'api') {
        return fail(`stub: no gh fixture for ${rest.join(' ')}`);
    }
    if (rest[1] === 'graphql') {
        return out({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
    }
    const [p] = rest[1].split('?');
    if (p === 'user') {
        return out({ login: 'tester', type: 'User' });
    }
    if (p === 'repos/acme/beta/milestones') {
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
