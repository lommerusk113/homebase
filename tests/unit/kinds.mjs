import assert from 'node:assert/strict';
import { KINDS, rowOf } from '../../server/items.mjs';
import { mr } from './helpers.mjs';

const GATE = 'Gate not passed for the latest commit — run review-gate';
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
const gateDemoted = { state: 'open', ready: false, approved: true, notReady: GATE, reviewers: [] };
assert.equal(rowOf(gateDemoted, null, opts).stage, 2, 'a gate-demoted MR sits in review, so its stage says Review, not Approved');
assert.equal(rowOf({ ...gateDemoted, notReady: '2 threads still open — resolve them' }, null, opts).stage, 3, 'approved with open threads stays Approved');
console.log('ok gate-demoted stage');

const blockedByGate = { state: 'open', blocked: 'blocked', approved: true, notReady: GATE, reviewers: [] };
assert.equal(rowOf(blockedByGate, null, opts).next, `Blocked by another MR · ${GATE}`, 'a blocked MR still names the gate step');
assert.equal(rowOf({ ...blockedByGate, notReady: null }, null, opts).next, 'Blocked by another MR');
console.log('ok blocked names the gate step');

const commentsOnly = { state: 'open', unresolved: 2, unresolvedBy: ['Ann'], reviewers: ['Ann'], ci: 'running' };
assert.equal(rowOf(commentsOnly, null, opts).state.kind, 'changes');
assert.deepEqual([rowOf(commentsOnly, null, opts).column, rowOf(commentsOnly, null, opts).action.label], ['needs-you', 'Fix & reply']);
assert.equal(rowOf({ ...commentsOnly, unresolved: 0, unanswered: 1, unansweredBy: ['Ann'] }, null, opts).action.label, 'Fix & reply');
assert.equal(rowOf({ ...commentsOnly, unresolved: 0 }, null, opts).state.kind, 'pipeline', 'no comments, no fix');
assert.equal(rowOf({ ...commentsOnly, ready: true, ci: null }, null, opts).action.label, 'Merge + close issue', 'an approved MR with open comments still merges');
console.log('ok comments get the fix button');

const everything = { state: 'open', changes: true, changesBy: ['Ann'], ci: 'failing', blocked: 'conflict', reviewers: ['Ann'] };
assert.equal(rowOf(everything, null, opts).next, 'Address review comments from Ann · Pipeline failing · Merge conflicts — rebase it', 'every blocker is named');
assert.equal(rowOf({ ...everything, changes: false, blocked: 'checks', notReady: GATE }, null, opts).next, `Pipeline failing · Waiting for external status checks · ${GATE}`);
assert.equal(rowOf({ state: 'open', ci: 'failing' }, null, opts).next, 'Pipeline failing');
console.log('ok next lists every blocker');
