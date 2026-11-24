import assert from 'node:assert/strict';
import { repoPath, groupIssues, milestoneOf, activeMilestones, keepMilestone, worksOn, noMilestones, mineView, reviewRows, excerpt } from '../../server.mjs';
import { inMilestone, toData, isLoading, emptyPill, pillLabel } from '../../web/src/lib/milestone.ts';
import { issueCards, buildLanes, closedBy, chatMessage, shortTitle, owners, emptyText } from '../../web/src/lib/issues.ts';
import { chatStatus } from '../../web/src/lib/chat.ts';
import { now } from './helpers.mjs';

{
    const mr = (iid, o) => ({ iid, state: 'opened', title: `T${iid}`, web_url: `https://gitlab.com/g/p/-/merge_requests/${iid}`, references: { full: `g/p!${iid}` }, author: { username: 'ann', name: 'Ann' }, draft: false, updated_at: `2026-01-0${iid}T00:00:00Z`, ...o });
    const rows = reviewRows([mr(1), mr(2, { author: { username: 'me' } }), mr(3, { draft: true, head_pipeline: { status: 'failed' } }), mr(4, { state: 'merged' })], 'me');
    assert.deepEqual(rows.map(r => r.iid), [3, 1]); // mine and non-open dropped, newest first
    assert.deepEqual([rows[0].draft, rows[0].pipeline?.status, rows[0].project, rows[0].author, rows[1].pipeline], [true, 'failed', 'g/p', 'Ann', null]);
}
{
    // a failed refresh keeps serving the last good list, and each outage logs once
    const { repoPaths } = await import('../../server/account.mjs');
    const { reviewRequests } = await import('../../server/reviews.mjs');
    const { swr } = await import('../../server/forge.mjs');
    repoPaths.set('rv', { host: 'gitlab.rv.test', path: 'g/rv' });
    const hit = { at: Date.now(), value: [{ url: 'u', iid: 1, title: 'Cached review' }], error: new Error('timed out\nmore') };
    swr.set('reviews:gitlab.rv.test', hit);
    const logged = [];
    const error = console.error;
    console.error = m => logged.push(m);
    try {
        assert.deepEqual(reviewRequests().map(r => r.iid), [1]);
        reviewRequests();
        hit.error = null;
        reviewRequests(); // recovered
        hit.error = new Error('502');
        assert.deepEqual(reviewRequests().map(r => r.iid), [1]);
    } finally {
        console.error = error;
        repoPaths.delete('rv');
        swr.delete('reviews:gitlab.rv.test');
    }
    assert.deepEqual(logged, ['reviews: gitlab.rv.test: timed out', 'reviews: gitlab.rv.test: 502']);
}
assert.deepEqual(repoPath('git@gitlab.com:tritt/accounting/pracsys.git\n'), { host: 'gitlab.com', path: 'tritt/accounting/pracsys' });
assert.deepEqual(repoPath('https://gitlab.com/tritt/accounting/pracsys.git'), { host: 'gitlab.com', path: 'tritt/accounting/pracsys' });
assert.deepEqual(repoPath('ssh://git@gitlab.example.com:2222/g/sub/p.git'), { host: 'gitlab.example.com', path: 'g/sub/p' });
assert.deepEqual(repoPath('github-personal:lommerusk113/homebase.git'), { host: 'github-personal', path: 'lommerusk113/homebase' });
assert.deepEqual(repoPath('https://github.com/contaas/portal-frontend/'), { host: 'github.com', path: 'contaas/portal-frontend' });
const iss = (iid, state, assignees = []) => ({ iid, title: `I${iid}`, state, assignees, url: `u${iid}` });
const g = groupIssues([iss(1, 'closed'), iss(2, 'open'), iss(3, 'open', ['Børre']), iss(4, 'open'), iss(5, 'open', ['Ann']), iss(6, 'open')], {
    2: [{ state: 'merged' }],
    4: [{ state: 'merged' }, { state: 'open' }], // follow-up still open
    6: [{ state: 'closed' }]
});
assert.deepEqual(Object.fromEntries(Object.entries(g.groups).map(([k, v]) => [k, v.map(i => i.iid)])),
    { closable: [2], doing: [4], assigned: [3, 5], unassigned: [6], done: [1] });
assert.deepEqual([g.total, g.closed, g.groups.assigned[0].assignees], [6, 1, ['Børre']]);
const msList = [{ id: 7, title: 'Supplier automation' }, { id: 8, title: 'Reports' }];
assert.deepEqual(milestoneOf({ milestone: { id: 9, title: 'Old', due_date: null }, target: 'supplier-automation' }, msList), { id: 9, title: 'Old' });
assert.deepEqual(milestoneOf({ milestone: null, target: 'supplier-automation' }, msList), { id: 7, title: 'Supplier automation' });
assert.equal(milestoneOf({ milestone: null, target: 'main' }, msList), null);
assert.deepEqual(activeMilestones([
    { state: 'merged', milestone: { id: 8, title: 'Reports' } }, { state: 'merged', milestone: { id: 8, title: 'Reports' } },
    { state: 'open', target: 'supplier-automation' }, { state: 'open', milestone: { id: 99, title: 'Closed one' } }
], msList), [7, 8]);
// an issue whose own milestone isn't the selected one is dropped, even if the API returned it (same-titled group milestone)
assert.deepEqual(keepMilestone([{ iid: 1, milestone: 7 }, { iid: 2, milestone: 70 }, { iid: 3 }], 7).map(i => i.iid), [1]);
// related MRs that only mention the issue don't count as work on it
assert.equal(worksOn({ title: '#2223 - Fix VAT', source_branch: 'x' }, 2223), true);
assert.equal(worksOn({ title: 'Fix VAT', source_branch: '2223-fix-vat' }, 2223), true);
assert.equal(worksOn({ title: '#2216 - Don\'t apply VAT code', source_branch: '2216-vat' }, 2223), false);
assert.equal(worksOn({ title: '#22230 - Other', source_branch: 'x' }, 2223), false);
const row = (pr, milestone) => ({ pr, milestone, prState: pr ? {} : null });
assert.equal(inMilestone(row('u', { id: 7, title: 'S' }), { id: 7 }), true);
assert.equal(inMilestone(row('u', { id: 8, title: 'R' }), { id: 7 }), false);
assert.equal(inMilestone(row('u', null), { id: 7 }), false); // an MR without a milestone is not in the picked one
assert.equal(inMilestone({ pr: 'u', milestone: null, prState: null }, { id: 7 }), true); // not checked yet: milestone unknown, stays
assert.equal(inMilestone({ ...row('u', { id: 8, title: 'R' }), column: 'needs-you' }, { id: 7 }), false); // waiting on you does not keep it
assert.equal(inMilestone({ ...row('u', null), column: 'ready' }, { id: 7 }), false);
assert.equal(inMilestone(row(null, null), { id: 7 }), true); // an agent without an MR or issue ref stays
assert.equal(inMilestone({ ...row(null, null), branch: '2263-links' }, { id: 7, issues: new Set([5]) }), false); // its issue is in another milestone
assert.equal(inMilestone({ ...row(null, null), worktreePath: '/w/5-fix' }, { id: 7, issues: new Set([5]) }), true);
assert.equal(inMilestone({ ...row(null, null), title: 'Fix #2263 comments' }, { id: 7, issues: null }), true); // issues not loaded: unknown, stays
assert.equal(inMilestone(row('u', null), null), true); // no milestone selected

// A project without milestones to show gets a final answer, never loading: true.
{
    const gl = { host: 'gitlab.com', path: 'g/p' }, gh = { host: 'github.com', path: 'o/r' };
    const none = noMilestones('p', gl, 'none');
    assert.deepEqual([none.milestones, none.selected, none.loading, none.updating, none.reason, none.url], [[], null, false, false, 'none', 'https://gitlab.com/g/p/-/milestones']);
    const err = noMilestones('r', gh, 'error', 'gh: Not Found (HTTP 404)');
    assert.deepEqual([err.reason, err.error, err.loading, err.url], ['error', 'gh: Not Found (HTTP 404)', false, 'https://github.com/o/r/milestones']);
    assert.equal(noMilestones('x', null, 'unsupported', 'unknown project').url, null);

    // client: any answer maps to data; one without a milestone list is the error state
    assert.deepEqual(toData(200, JSON.stringify(none)), none);
    const bare = toData(500, 'Command failed: gh api …\n');
    assert.deepEqual([bare.reason, bare.error, bare.milestones, bare.selected], ['error', 'Command failed: gh api …', [], null]);
    assert.equal(toData(502, '').error, 'HTTP 502');
    assert.equal(toData(500, '', 'p').project, 'p'); // the Issues tab names the project in the error
    // fast polling stops on a final state, even while a refresh of the list runs in the background
    assert.equal(isLoading({ ...err, updating: true }), false);
    assert.equal(isLoading({ reason: null, selected: { loading: true }, updating: false }), true);
    assert.equal(isLoading({ reason: null, loading: true, selected: null, updating: false }), true, 'a slow first milestone list keeps the fast poll');
    assert.equal(isLoading({ reason: null, selected: { groups: {} }, updating: false }), false);
    assert.deepEqual(emptyPill(none), { text: 'No milestones', tip: 'No open milestones in p', err: false });
    assert.deepEqual(emptyPill(err), { text: 'Milestones unavailable', tip: 'gh: Not Found (HTTP 404)\nRefresh (r) to retry', err: true });
    assert.equal(emptyPill({ reason: null }), null);
    assert.equal(emptyText(none), 'No open milestones in p.');
    assert.match(emptyText(err), /^Milestones unavailable for r: gh: Not Found \(HTTP 404\)\. Press r/);
    assert.equal(emptyText(noMilestones('x', null, 'unsupported', 'unknown project')), "Milestones aren't available for x: unknown project.");
}
// "mine" without a known user is an error in the view, not an empty list; it still lists the milestones for the menu
{
    const v = mineView('p', { host: 'gitlab.com', path: 'g/p' }, [], null);
    assert.deepEqual([v.reason, v.selected.id, v.selected.mine, v.selected.groups, v.selected.error], [null, 'mine', true, undefined, 'could not tell who you are on this forge']);
    assert.equal(v.selected.url, 'https://gitlab.com/g/p/-/issues');
}
console.log('ok milestones');

assert.equal(excerpt('## Problem\n\nThe **row** only shows after a [reload](http://x).\n\n```js\ncode()\n```\nDone.'), 'The row only shows after a reload. Done.');
assert.equal(excerpt('word '.repeat(100), 20), 'word word word word…');
assert.equal(excerpt(null), '');
const P = (name, username) => ({ name, username });
const me = P('Joakim Landsverk', 'jo'), bo = P('Børre Gaup', 'bo'), ann = P('Ann Ek', 'ann');
const isu = (iid, assignees = [], mrs = []) => ({ iid, title: `Supplier automation: I${iid}`, assignees, mrs });
const groups = {
    doing: [isu(1, [me], [{ iid: 11, state: 'open', author: me }]), isu(2, [], [{ iid: 12, state: 'open', author: bo }])],
    closable: [isu(3, [ann], [{ iid: 13, state: 'merged', author: ann }])],
    assigned: [isu(4, [bo, me])], unassigned: [isu(5), isu(6)],
    done: [isu(7, [me]), isu(8, [bo]), isu(9), isu(10, [P('Zed Old', 'zed')])]
};
const cards = issueCards(groups);
assert.deepEqual(cards.map(c => [c.iid, c.st]), [[1, 'doing'], [2, 'doing'], [3, 'closable'], [4, 'todo'], [5, 'free'], [6, 'free']]);
assert.deepEqual(owners(cards[1]), [bo]); // in progress, nobody assigned: the MR's author
const lanes = buildLanes(cards, groups.done, me);
// you first, then by name, then Unassigned; a closed-only person gets no lane
assert.deepEqual(lanes.map(l => [l.who?.username ?? null, l.me, l.list.map(c => c.iid), l.closed]),
    [['jo', true, [1, 4], 1], ['ann', false, [3], 0], ['bo', false, [2, 4], 1], [null, false, [5, 6], 1]]);
assert.deepEqual(buildLanes([], [], null).map(l => l.who), [null]); // Unassigned is always there
assert.deepEqual(closedBy(groups.done), [['Børre Gaup', 1], ['Joakim Landsverk', 1], ['Zed Old', 1], ['unassigned', 1]]);
assert.equal(chatMessage(cards[3]), 'Implement #4');
assert.equal(chatMessage(cards[0]), 'Check on #1 and !11');
assert.equal(chatMessage({ iid: 5, mrs: [{ iid: 20, state: 'merged' }, { iid: 21, state: 'open' }] }), 'Check on #5 and !21');
assert.equal(shortTitle('Supplier automation v2: undo misses pastes', 'Supplier automation'), 'undo misses pastes');
assert.equal(shortTitle('Fix: undo', 'Supplier automation'), 'Fix: undo');
const msel = { title: 'Supplier automation', total: 59, closed: 48, due: null, groups: { doing: [1, 2, 3], closable: [], assigned: [1, 2, 3], unassigned: [1, 2, 3, 4, 5] } };
assert.deepEqual(pillLabel({ title: 'Reports', total: 10, closed: 4, due: null, loading: true }), { text: '6 open', tip: 'Reports: loading issues… · no due date' });
assert.deepEqual(pillLabel(msel), { text: '11 open', tip: 'Supplier automation: 11 open of 59 (3 in progress, 3 not started, 5 unassigned), 48 closed · no due date' });
console.log('ok issues');

assert.equal(chatStatus(null).kind, 'idle');
assert.equal(chatStatus({}).text, 'Claude is done'); // nothing pending: no "your turn"
assert.equal(chatStatus({ items: [{ role: 'assistant', text: '', waiting: 'which cache' }, { role: 'user', text: 'also fix the typo' }] }).text, 'Claude needs your answer', 'an open decision outlives a later message');
assert.deepEqual(chatStatus({ stuck: true }), { kind: 'stuck', text: 'No activity for 30 min — Claude may be stuck' });
assert.equal(chatStatus({}, 0, { needsYou: true, subagents: { running: 2, finished: 0 } }).text, 'Claude needs your answer', 'running helpers are not mentioned');
assert.equal(chatStatus({ error: true, working: true, asking: 'Pick one?' }).kind, 'error'); // a failed poll never reads as idle or stale working
assert.match(chatStatus({ error: true }).text, /reconnecting/);
assert.equal(chatStatus({ working: true, asking: 'Pick one?', items: [] }).kind, 'asking'); // asking wins
const askedAt = new Date(now - 125 * 60_000).toISOString();
assert.equal(chatStatus({ working: true, items: [{ role: 'user', at: askedAt }, { role: 'user', at: new Date(now).toISOString(), pending: true }] }, now).text, 'Claude is working… · 2h5m');
assert.equal(chatStatus({ working: true, items: [] }, now).text, 'Claude is working…');
assert.equal(chatStatus({ working: true, items: [] }, now, { needsYou: false, subagents: { running: 0, finished: 0 }, step: 'running npm test' }).text, 'Claude is working… · running npm test');
assert.equal(chatStatus({ working: true, since: now - 2 * 60_000, items: [{ role: 'user', at: askedAt }] }, now).text, 'Claude is working… · 2m'); // turn start wins
console.log('ok chat status');
