// docs/row-states.md, line by line: every precedence rule and MR kind, with its group and button, and the same answer
// for the same inputs whatever order the sessions come in.
import assert from 'node:assert/strict';
import { workItems } from '../../server/items.mjs';
import { HOLD_MS } from '../../server/once.mjs';
import { byStart } from '../../web/src/lib/board.ts';
import { open, mr } from './helpers.mjs';

const url = mr(1), NOW = 10_000_000;
const main = (extra = {}) => ({ id: 'm', project: 'p', prs: [{ url, at: 1 }], agents: [], status: 'idle', ...extra });
const helper = extra => ({ id: 'a', description: 'Fix !1', status: 'running', stage: 1, updated: NOW - 1000, prs: [url], ...extra });
const chat = extra => ({ id: 'c', project: 'p', prs: [], agents: [], status: 'idle', ...extra });
const row = (ps, sessions = [main()], sent = new Map(), errorOf = () => null) =>
    workItems(sessions, () => ps, NOW, new Map(), [], new Map(), errorOf, sent).find(x => x.pr === url);
const shown = x => [x.column, x.action?.label ?? null];

// the MR state alone: first blocker wins (table "MR state")
const kinds = [
    ['changes', open({ unresolved: 1 }), 'needs-you', 'Fix & reply'],
    ['changes', open({ changes: true, ci: 'failing', blocked: 'conflict' }), 'needs-you', 'Fix & reply'],
    ['failing', open({ ci: 'failing', blocked: 'conflict' }), 'needs-you', 'Fix pipeline'],
    ['conflict', open({ blocked: 'conflict' }), 'needs-you', 'Rebase'],
    ['conflict', open({ blocked: 'rebase' }), 'needs-you', 'Rebase'],
    ['blocked', open({ blocked: 'checks', draft: true }), 'review', 'Review'],
    ['draft', open({ draft: true }), 'needs-you', 'Mark ready'],
    ['pipeline', open({ draft: true, ci: 'running' }), 'review', 'Review'],
    ['threads', open({ ready: true, approved: true, replied: 2 }), 'review', null],
    ['replied', open({ replied: 1, reviewers: ['Ann'] }), 'review', 'Review'],
    ['pipeline', open({ ci: 'running', reviewers: ['Ann'] }), 'review', 'Review'],
    ['ready', open({ ready: true, sha: 'abc1234' }), 'ready', 'Merge'],
    ['in-review', open({ reviewers: ['Ann'] }), 'review', 'Review'],
    ['needs-reviewer', open(), 'review', 'Request review']
];
for (const [kind, ps, column, label] of kinds) {
    const x = row(ps);
    assert.deepEqual([x.state.kind, ...shown(x)], [kind, column, label], `${kind}: ${JSON.stringify(ps)}`);
}
console.log('ok every MR kind has its group and button');

// precedence (table "Precedence for an MR row"), each rule against a conflicting MR that would otherwise need you
const conflict = open({ blocked: 'conflict', branch: '1-x' });
const asks = chat({ status: 'waiting', needsYou: true, asks: '!1: keep both migrations?' });
const rules = [
    ['1 merged beats a running helper', { state: 'merged' }, [main({ agents: [helper()] })], 'done', null],
    ['2 closed beats a waiting chat', { state: 'closed' }, [main(), asks], 'closed', null],
    ['3 a chat waiting on you beats a running helper', conflict, [main({ agents: [helper()] }), asks], 'needs-you', null],
    ['3 a reported needs-you', conflict, [main(), chat({ status: 'waiting', report: { phase: 'needs-you', mr: '!1', text: 'Which?', at: 5 } })], 'needs-you', 'Rebase'],
    ['4 a running helper', conflict, [main({ agents: [helper()] })], 'doing', null],
    ['5 a chat working on its branch', conflict, [main(), chat({ status: 'working', head: '1-x' })], 'doing', null],
    ['5 a chat on another branch is not it', conflict, [main(), chat({ status: 'working', head: 'main' })], 'needs-you', 'Rebase'],
    ['5 a reported doing', conflict, [main(), chat({ status: 'working', report: { phase: 'doing', mr: '!1', text: 'Rebasing', at: 5 } })], 'doing', null],
    ['5 a working chat beats its own open prompt', conflict, [main(), chat({ status: 'working', head: '1-x', openPrompts: [{ at: new Date(NOW).toISOString(), text: 'rebase !1' }] })], 'doing', null],
    ['6 an open prompt names it', conflict, [main({ openPrompts: [{ at: new Date(NOW).toISOString(), text: 'rebase !1' }] })], 'doing', null],
    ['8 a stopped helper', open({ reviewers: ['Ann'] }), [main({ agents: [helper({ status: 'stopped', stopReason: 'api-error' })] })], 'needs-you', 'Continue'],
    ['9 no forge answer', null, [main()], 'unknown', null]
];
for (const [name, ps, sessions, column, label] of rules) {
    assert.deepEqual(shown(row(ps, sessions)), [column, label], name);
}
// 7 the click: holds while the kind is the same and under HOLD_MS, then the button is back
const sent = at => new Map([[url, { at, kind: 'conflict' }]]);
assert.deepEqual(shown(row(conflict, [main()], sent(NOW - 1000))), ['doing', null], '7 a fresh click holds it in Doing');
assert.deepEqual(shown(row(conflict, [main()], sent(NOW - HOLD_MS))), ['needs-you', 'Rebase'], '7 an old click no longer holds it');
assert.deepEqual(shown(row(open({ reviewers: ['Ann'] }), [main()], sent(NOW - 1000))), ['review', 'Review'], '7 a changed MR ends the hold');
assert.equal(row(conflict, [main(), chat({ status: 'working', head: '1-x', step: 'running tests', openPrompts: [{ at: new Date(NOW).toISOString(), text: 'rebase !1' }] })]).next, 'Running tests', '5 says what the chat does');
{
    // a changed kind ends the click: the same failure coming back later shows its button
    const clicks = sent(NOW - 1000);
    row(open({ ci: 'running', reviewers: ['Ann'] }), [main()], clicks);
    assert.deepEqual(shown(row(conflict, [main()], clicks)), ['needs-you', 'Rebase'], '7 the conflict is back after the MR moved on');
}
assert.deepEqual(shown(row(conflict, [main(), asks], sent(NOW - 1000))), ['needs-you', 'Rebase'], '3 a question beats a held click, with the MR step button');
console.log('ok precedence');

// a helper without an MR (table "A helper without an MR")
const loose = a => workItems([{ ...main(), prs: [], agents: [a] }], () => null, NOW).find(x => !x.pr);
assert.deepEqual(shown(loose(helper({ prs: [], description: 'Tidy' }))), ['doing', null]);
for (const why of ['api-error', 'rate-limit', 'interrupted', 'closed', 'silent']) {
    assert.deepEqual(shown(loose(helper({ prs: [], description: 'Tidy', status: 'stopped', stopReason: why }))), ['needs-you', 'Continue'], why);
}
assert.deepEqual(shown(loose(helper({ prs: [], description: 'Tidy', status: 'done' }))), ['finished', null]);
{
    const stopped = helper({ prs: [], description: 'Tidy', status: 'stopped', stopReason: 'api-error' });
    const held = new Map([['a', { at: NOW - 1000, kind: 'api-error' }]]);
    const x = workItems([{ ...main(), prs: [], agents: [stopped] }], () => null, NOW, new Map(), [], new Map(), () => null, held).find(r => !r.pr);
    assert.deepEqual(shown(x), ['doing', null], 'a clicked Continue holds a helper row too, on every device');
}
assert.equal(loose(helper({ prs: [], description: 'Tidy', status: 'done', updated: NOW - 3 * 3600_000 })), undefined, 'gone after 2 hours');
console.log('ok helpers without an MR');

// same inputs, same rows: the order sessions come in changes nothing
{
    const sessions = [main({ agents: [helper({ status: 'done' })] }), chat({ status: 'working', head: '1-x' }), chat({ id: 'd', status: 'working', report: { phase: 'doing', mr: '!1', text: 'Testing', at: 5 } }), asks];
    const key = list => JSON.stringify(workItems(list, () => conflict, NOW).map(x => [x.key, x.column, x.next, x.action?.label]));
    const want = key(sessions);
    for (const order of [[3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]]) {
        assert.equal(key(order.map(i => sessions[i])), want, `order ${order}`);
    }
}
console.log('ok same inputs, same rows');

// order inside a group: when the row first appeared, never its last activity
{
    const rows = [{ key: 'a', since: 1, updated: 99 }, { key: 'b', since: 3, updated: 2 }, { key: 'c', since: null, updated: 2 }, { key: 'd', since: 3, updated: 50 }];
    assert.deepEqual(rows.toSorted(byStart).map(r => r.key), ['b', 'd', 'c', 'a']);
}
console.log('ok order by first appearance');
