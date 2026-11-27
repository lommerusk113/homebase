// The merge queue: what the head of a line does, one line per target branch, and what is kept across a restart. Fake rebase and merge only.
import assert from 'node:assert/strict';
import { queueStep, advanceQueue, placeOf, restoreQueue } from '../../server/queue.mjs';

const ok = { state: 'open', approved: true, reviewRequired: true, ready: true, blocked: null, ci: null, sha: 'aaa1111', target: 'main' };
assert.equal(queueStep(ok).do, 'merge');
assert.equal(queueStep({ ...ok, ready: false, blocked: 'rebase' }).do, 'rebase');
assert.equal(queueStep({ ...ok, ready: false, ci: 'running' }).do, 'wait');
assert.equal(queueStep({ ...ok, ready: false, mergeable: null }).do, 'wait');
assert.equal(queueStep({ ...ok, state: 'merged' }).do, 'done');
for (const [why, ps] of [['closed', { state: 'closed' }], ['conflicts', { blocked: 'conflict' }], ['pipeline', { ci: 'failing' }], ['approval', { approved: false }],
    ['discussions', { mergeStatus: 'discussions_not_resolved' }], ['draft', { draft: true }]]) {
    assert.equal(queueStep({ ...ok, ...ps }).do, 'stop', why);
}
assert.equal(queueStep({ ...ok, approved: false, reviewRequired: false }).do, 'merge', 'a project that needs no approval');
console.log('ok queue step');

// one per target: only the oldest of a line moves; a rebase leaves it in the queue, a merge takes it out, a failure stops it with the reason
{
    const calls = [], queue = new Map(), stops = new Map();
    const mr = n => `https://gitlab.com/g/p/-/merge_requests/${n}`;
    queue.set(mr(1), { at: 1, project: 'p', target: 'main' });
    queue.set(mr(2), { at: 2, project: 'p', target: 'main' });
    queue.set(mr(3), { at: 3, project: 'p', target: 'dev' });
    const rows = ps => [1, 2, 3].map(n => ({ pr: mr(n), prState: { ...ok, ...(ps[n] ?? {}), target: n === 3 ? 'dev' : 'main' } }));
    assert.deepEqual(placeOf(mr(2), queue), { n: 2, of: 2 });
    assert.deepEqual(placeOf(mr(3), queue), { n: 1, of: 1 });
    const deps = { rebase: async u => { calls.push(['rebase', u]); }, merge: async (u, sha) => { calls.push(['merge', u, sha]); }, queue, stops };
    advanceQueue(rows({ 1: { ready: false, blocked: 'rebase' } }), () => {}, deps);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls, [['rebase', mr(1)], ['merge', mr(3), 'aaa1111']]);
    assert.equal(queue.size, 2, 'the rebased head stays, the merged one of the other line is out');
    calls.length = 0;
    advanceQueue(rows({}), () => {}, deps);
    await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(calls, [['merge', mr(1), 'aaa1111']]);
    // the next one only after the head is gone; a failed merge stops the head with GitLab's reason
    calls.length = 0;
    const failing = { ...deps, merge: async () => { throw new Error("Couldn't merge: glab: 406 Branch cannot be merged"); } };
    queue.set(mr(1), { at: 1, project: 'p', target: 'main' });
    advanceQueue(rows({}), () => {}, failing);
    await new Promise(r => setTimeout(r, 5));
    assert.equal(queue.has(mr(1)), false);
    assert.deepEqual(stops.get(mr(1)), { reason: 'glab: 406 Branch cannot be merged', sha: 'aaa1111' });
    advanceQueue(rows({ 2: { ci: 'failing' } }), () => {}, deps);
    assert.equal(queue.has(mr(2)), false, 'its pipeline failed: out of the queue');
    assert.equal(stops.get(mr(2)).reason, 'its pipeline failed');
    console.log('ok queue');
}

// kept across a restart with the store entry
{
    const queue = new Map();
    const url = 'https://gitlab.com/g/p/-/merge_requests/9';
    restoreQueue({ data: { p: { [url]: { state: 'open', queued: { at: 5, target: 'main' } }, 'https://gitlab.com/g/p/-/merge_requests/10': { state: 'merged', queued: { at: 6, target: 'main' } } } } }, queue);
    assert.deepEqual([...queue], [[url, { at: 5, project: 'p', target: 'main', step: null }]]);
    console.log('ok queue restored');
}
