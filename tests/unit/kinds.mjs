import assert from 'node:assert/strict';
import { KINDS, rowOf } from '../../server/items.mjs';
import { mr } from './helpers.mjs';

const url = mr(1);

// every kind has a group and a stage, and only ready can merge
for (const [kind, k] of Object.entries(KINDS)) {
    assert.ok(k.column, `${kind} has a column`);
    assert.equal(typeof k.next, 'function', `${kind} has a text`);
    assert.equal(typeof k.stage, 'function', `${kind} has a stage`);
    const sample = k.action({ pr: url, title: 'T', agent: { updated: 0 } });
    assert.equal(/^Merge/.test(sample?.label ?? ''), kind === 'ready', `${kind} merge`);
}
console.log('ok every kind has a column and only ready merges');

const opts = { pr: url, title: 'T' };
const threads = 'Approved — waiting for the reviewer to resolve 2 threads';
assert.equal(rowOf({ state: 'open', ready: false, approved: true, notReady: threads, reviewers: [] }, null, opts).stage, 3, 'approved with open threads stays Approved');
assert.equal(rowOf({ state: 'open', blocked: 'blocked', approved: true, notReady: threads, reviewers: [] }, null, opts).next, `Blocked by another MR · ${threads}`);
assert.equal(rowOf({ state: 'open', blocked: 'blocked', approved: true, reviewers: [] }, null, opts).next, 'Blocked by another MR');
console.log('ok approved with threads');

const commentsOnly = { state: 'open', unresolved: 2, unresolvedBy: ['Ann'], reviewers: ['Ann'], ci: 'running' };
assert.equal(rowOf(commentsOnly, null, opts).state.kind, 'changes');
assert.deepEqual([rowOf(commentsOnly, null, opts).column, rowOf(commentsOnly, null, opts).action.label], ['needs-you', 'Fix & reply']);
assert.equal(rowOf({ ...commentsOnly, unresolved: 0, unanswered: 1, unansweredBy: ['Ann'] }, null, opts).action.label, 'Fix & reply');
assert.equal(rowOf({ ...commentsOnly, unresolved: 0 }, null, opts).state.kind, 'pipeline', 'no comments, no fix');
assert.equal(rowOf({ ...commentsOnly, ready: true, ci: null }, null, opts).action.label, 'Fix & reply', 'an approved MR with open comments answers them before it merges');
console.log('ok comments get the fix button');

const everything = { state: 'open', changes: true, changesBy: ['Ann'], ci: 'failing', blocked: 'conflict', reviewers: ['Ann'] };
assert.equal(rowOf(everything, null, opts).next, 'Address review comments from Ann · Pipeline failing · Merge conflicts — rebase it', 'every blocker is named');
assert.equal(rowOf({ ...everything, changes: false, blocked: 'checks', notReady: threads }, null, opts).next, `Pipeline failing · Waiting for external status checks · ${threads}`);
assert.equal(rowOf({ state: 'open', ci: 'failing' }, null, opts).next, 'Pipeline failing');
console.log('ok next lists every blocker');

// every kind in Needs you says why before any helper text, and has a button
const done = { status: 'done', outcome: 'Verdict: ready on MR !1.', updated: 0 };
const stopped = r => ({ status: 'stopped', stopReason: r, updated: 0 });
const needsYou = {
    stopped: [null, stopped(undefined)],
    'api-error': [null, stopped('api-error')],
    'rate-limit': [null, stopped('rate-limit')],
    interrupted: [null, stopped('interrupted')],
    closed: [null, stopped('closed')],
    silent: [null, stopped('silent')],
    changes: [{ state: 'open', unresolved: 1 }, done],
    failing: [{ state: 'open', ci: 'failing' }, done],
    conflict: [{ state: 'open', blocked: 'conflict' }, done],
    draft: [{ state: 'open', draft: true, ci: 'passed', reviewers: [] }, done]
};
assert.deepEqual(Object.keys(needsYou).toSorted(), Object.keys(KINDS).filter(k => KINDS[k].column === 'needs-you').toSorted(), 'every Needs-you kind has a case');
for (const [kind, [ps, agent]] of Object.entries(needsYou)) {
    const row = rowOf(ps, agent, opts);
    assert.equal(row.state.kind, kind);
    assert.equal(row.column, 'needs-you');
    assert.ok(row.next && !row.next.startsWith('Helper finished'), `${kind} leads with its reason: ${row.next}`);
    assert.ok(row.action?.label, `${kind} has a button`);
}
console.log('ok every Needs-you kind leads with its reason and has a button');

// a green draft: ready except the draft flag, whatever the helper said; blockers beat the draft reason
const draft = { state: 'open', draft: true, ci: 'passed', reviewers: ['Ann'], approved: true };
const green = rowOf(draft, done, opts);
assert.equal(green.next, 'Ready except draft: mark ready · Helper finished: Verdict: ready on MR !1');
assert.equal(green.action.label, 'Mark ready');
assert.match(green.action.message, /^Run review-gate on !1 /);
assert.equal(rowOf({ ...draft, replied: 1 }, null, opts).state.kind, 'draft', 'replied threads do not hide the draft');
assert.equal(rowOf({ ...draft, ci: 'running' }, null, opts).column, 'review', 'a running pipeline is waited for');
assert.equal(rowOf({ ...draft, ci: 'failing' }, null, opts).next, 'Pipeline failing');
assert.equal(rowOf({ ...draft, unresolved: 2 }, null, opts).next, 'Address 2 unresolved comments');
assert.equal(rowOf({ ...draft, blocked: 'checks' }, null, opts).next, 'Waiting for external status checks');
console.log('ok green draft says Ready except draft with Mark ready');
