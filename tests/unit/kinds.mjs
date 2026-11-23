import assert from 'node:assert/strict';
import { itemColumn, nextStep, rowAction, lifecycle, KINDS, rowOf } from '../../server/items.mjs';
import { mr } from './helpers.mjs';

const GATE = 'Gate not passed for the latest commit — run review-gate';
const url = mr(1);
const bools = [false, true];

// every MR state the forge and demote() can produce: ready means merge now, so it excludes a blocker, a pipeline, open threads and a demote note
const mrStates = [];
for (const changes of bools) for (const unresolved of [0, 1]) for (const ci of [null, 'failing', 'running']) for (const blocked of [null, 'conflict', 'rebase', 'blocked', 'checks'])
    for (const draft of bools) for (const ready of bools) for (const replied of [0, 2]) for (const notReady of [null, GATE, '2 threads still open — resolve them'])
        for (const reviewers of [[], ['Ann']]) for (const approved of bools) {
            if (ready && (ci || blocked || replied || notReady)) {
                continue;
            }
            mrStates.push({ state: 'open', changes, unresolved, ci, blocked, draft, ready, replied, notReady, reviewers, approved, unanswered: 0 });
        }

const agents = [
    null,
    { status: 'running', stage: 1, description: 'Impl' },
    { status: 'running', stage: 2, description: 'Impl', step: 'running unit tests' },
    { status: 'stopped' },
    { status: 'stopped', stopReason: 'api-error', updated: 1_000_000 },
    { status: 'stopped', stopReason: 'rate-limit' },
    { status: 'stopped', stopReason: 'interrupted' },
    { status: 'done' },
    { status: 'done', outcome: 'Nothing left to push.', updated: 1_000_000 }
];

let n = 0;
for (const ps of [...mrStates, { state: 'merged' }, { state: 'closed' }, null]) {
    for (const agent of agents) {
        for (const requested of bools) {
            const row = rowOf(ps, agent, { pr: url, title: 'T', requested });
            const merged = ps?.state === 'merged' || ps?.state === 'closed';
            const live = requested && !merged && agent?.status !== 'running';
            const old = {
                column: live ? 'doing' : itemColumn(ps, agent, true),
                next: live ? 'Claude is on it…' : nextStep(ps, agent, 'MR'),
                action: live ? null : rowAction(url, ps, agent, 'T'),
                stage: lifecycle(url, ps, agent)
            };
            if (requested && !live) {
                continue; // workItems only asks for a request when nothing runs and the MR is open
            }
            // what the rows changed on purpose since the old rules (each has its own test below)
            if (row.state.kind === 'gate') {
                old.stage = 2;
            }
            if (row.state.kind === 'changes' && !ps.changes) {
                Object.assign(old, { column: 'needs-you', action: row.action }); // comments alone ask for a fix too, see below
            }
            assert.deepEqual({ column: row.column, next: row.next, action: row.action, stage: row.stage }, old, JSON.stringify({ ps, agent, requested }));
            n++;
        }
    }
}

// no MR: a helper alone
for (const agent of agents.slice(1)) {
    const row = rowOf(null, agent, { title: 'T', aMr: 'a MR' });
    const col = itemColumn(null, agent, false);
    assert.equal(row.column, col);
    assert.equal(row.next, col === 'finished' ? 'Finished without a MR' : nextStep(null, agent, 'MR'));
    assert.deepEqual([row.action, row.stage], [rowAction(null, null, agent, 'T'), lifecycle(null, null, agent)]);
    n++;
}
console.log(`ok kinds match the old rules (${n} rows)`);

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
