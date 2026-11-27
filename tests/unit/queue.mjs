// The merge queue: what the head of a line does, one line per target branch, and what is kept across a restart. Fake rebase and merge only.
import assert from 'node:assert/strict';
import { queueStep, advanceQueue, placeOf, restoreQueue } from '../../server/queue.mjs';

const ok = { state: 'open', approved: true, reviewRequired: true, ready: true, blocked: null, ci: null, sha: 'aaa1111', target: 'main' };
assert.equal(queueStep(ok).do, 'merge');
assert.equal(queueStep({ ...ok, ready: false, blocked: 'rebase' }).do, 'rebase');
assert.equal(queueStep({ ...ok, ready: false, ci: 'running' }).do, 'wait');
assert.equal(queueStep({ ...ok, ready: false, mergeable: null }).do, 'wait');
assert.equal(queueStep({ ...ok, state: 'merged' }).do, 'done');
for (const [why, ps] of [['closed', { state: 'closed' }], ['approval', { approved: false }],
    ['discussions', { mergeStatus: 'discussions_not_resolved' }], ['draft', { draft: true }]]) {
    assert.equal(queueStep({ ...ok, ...ps }).do, 'stop', why);
}
// a conflict or failed pipeline is for the chat to fix, but not when something else would stop it anyway
assert.deepEqual(queueStep({ ...ok, blocked: 'conflict' }), { do: 'fix', kind: 'conflict', why: 'it has merge conflicts' });
assert.deepEqual(queueStep({ ...ok, ci: 'failing' }), { do: 'fix', kind: 'pipeline', why: 'its pipeline failed' });
for (const [why, ps] of [['approval', { approved: false }], ['draft', { draft: true }], ['discussions', { changes: true }]]) {
    assert.equal(queueStep({ ...ok, blocked: 'conflict', ...ps }).do, 'stop', `conflict and ${why}`);
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
    advanceQueue(rows({ 2: { ci: 'failing' } }), () => {}, { ...deps, start: async () => { throw new Error('no chat of this project is open'); } });
    await new Promise(r => setTimeout(r, 5));
    assert.equal(queue.has(mr(2)), false, 'its pipeline failed and no helper can fix it: out of the queue');
    assert.equal(stops.get(mr(2)).reason, 'its pipeline failed and its helper could not be started (no chat of this project is open)');
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

// a conflict or failed pipeline: a fix helper is started once, the MR stays queued while the next of its line goes, and it is back in turn when clean
{
    const started = [], calls = [], queue = new Map(), stops = new Map();
    const mr = n => `https://gitlab.com/g/p/-/merge_requests/${n}`;
    queue.set(mr(1), { at: 1, project: 'p', target: 'main' });
    queue.set(mr(2), { at: 2, project: 'p', target: 'main' });
    let status = 'idle';
    const row = (n, ps = {}, extra = {}) => ({ pr: mr(n), prState: { ...ok, ...ps }, sessionId: `chat${n}`, ...extra });
    const start = async (r, action) => { started.push([r.pr, action]); return { helper: { id: `helper${started.length}` } }; };
    const run = (rows, now, over = {}) => advanceQueue(rows, () => {}, { rebase: async u => { calls.push(['rebase', u]); }, merge: async (u, sha) => { calls.push(['merge', u, sha]); }, queue, stops, start, chat: id => (id ? { id, status } : null), now, ...over });
    const tick = () => new Promise(r => setTimeout(r, 5));

    run([row(1, { blocked: 'conflict', ready: false }), row(2)], 1000);
    await tick();
    assert.deepEqual(started, [[mr(1), 'conflict']], 'its helper is started once');
    assert.deepEqual(calls, [['merge', mr(2), 'aaa1111']], 'the next MR of the line goes meanwhile');
    assert.equal(queue.get(mr(1)).step, 'waiting for its helper to fix the conflict');
    assert.equal(queue.get(mr(1)).fix.helper, 'helper1', 'the helper is remembered, its chat is the one watched');
    // still broken while its helper works: nothing more is started, nothing dropped
    status = 'working';
    run([row(1, { blocked: 'conflict', ready: false })], 1000 + 10 * 60_000);
    run([row(1, { blocked: 'conflict', ready: false })], 1000 + 20 * 60_000);
    assert.equal(started.length, 1);
    assert.equal(queue.has(mr(1)), true);
    // clean again: it is the head again and merges in turn
    calls.length = 0;
    run([row(1)], 1000 + 21 * 60_000);
    await tick();
    assert.deepEqual(calls, [['merge', mr(1), 'aaa1111']]);

    // the helper goes idle and the MR is still broken: its fix failed, with the reason
    queue.set(mr(1), { at: 1, project: 'p', target: 'main' });
    started.length = 0;
    status = 'idle';
    run([row(1, { ci: 'failing' })], 5_000_000);
    await tick();
    assert.deepEqual(started, [[mr(1), 'failing']]);
    run([row(1, { ci: 'failing' })], 5_000_000 + 60_000); // idle, but not for long enough yet
    assert.equal(queue.has(mr(1)), true);
    run([row(1, { ci: 'failing' })], 5_000_000 + 160_000);
    assert.equal(queue.has(mr(1)), false);
    assert.equal(stops.get(mr(1)).reason, 'its helper could not fix the pipeline');

    // another cause while it waits, a helper that can't be started (also: no chat is open), the episode cap: dropped with the reason
    for (const [name, rows, over, reason] of [
        ['threads', [row(1, { ci: 'failing' })], {}, null],
        ['refused', [row(1, { ci: 'failing' })], { start: async () => { throw new Error('no chat of this project is open'); } }, 'its pipeline failed and its helper could not be started (no chat of this project is open)'],
        ['no starter', [row(1, { blocked: 'conflict' })], { start: undefined }, 'it has merge conflicts and its helper could not be started (no helper starter)']
    ]) {
        queue.clear();
        stops.clear();
        queue.set(mr(1), { at: 1, project: 'p', target: 'main' });
        run(rows, 9_000_000, over);
        await tick();
        if (name === 'threads') {
            run([row(1, { ci: 'failing', mergeStatus: 'discussions_not_resolved' })], 9_000_100);
            assert.equal(stops.get(mr(1)).reason, 'it has unresolved discussions');
        } else {
            assert.equal(stops.get(mr(1))?.reason, reason, name);
        }
        assert.equal(queue.has(mr(1)), false, name);
    }
    queue.clear();
    stops.clear();
    queue.set(mr(1), { at: 1, project: 'p', target: 'main', fixes: 3 });
    run([row(1, { ci: 'failing' })], 9_000_000);
    assert.equal(stops.get(mr(1)).reason, 'its pipeline failed', 'after three helpers it leaves');
    // a restart keeps that it was asked
    const restored = new Map();
    restoreQueue({ data: { p: { [mr(1)]: { state: 'open', queued: { at: 5, target: 'main', fix: { kind: 'conflict', at: 7, sha: 'a' }, fixes: 1 } } } } }, restored);
    assert.deepEqual(restored.get(mr(1)).fix, { kind: 'conflict', at: 7, sha: 'a', idleSince: null });
    console.log('ok queue fixes');
}
