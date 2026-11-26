// docs/row-states.md, line by line for the server's tables (MR rows, helpers without an MR, order): every precedence rule
// and MR kind with its group and button, and the same answer for the same inputs whatever order they come in. The chats'
// own rows and Dismiss are the page's: tests/browser/work.test.mjs and edges.test.mjs check them.
import assert from 'node:assert/strict';
import { workItems } from '../../server/items.mjs';
import { withThreads } from '../../server/forge.mjs';
import { HOLD_MS, mergeRefusal } from '../../server/once.mjs';
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
    ['ready', open({ ready: true, approved: true, replied: 2, sha: 'abc1234' }), 'ready', 'Merge'], // open threads GitLab lets merge: information, not a blocker
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
// through withThreads, as the server does: comments nobody answered need you, also on an approved MR; replied ones don't
{
    const approved = withThreads(open({ ready: true, approved: true, approvedBy: ['Ann'], sha: 'abc1234' }), { unanswered: 1, unansweredBy: ['Bo'] });
    assert.deepEqual([row(approved).state.kind, ...shown(row(approved))], ['changes', 'needs-you', 'Fix & reply']);
    assert.match(row(approved).next, /^Approved — 1 unanswered comment from Bo/);
    // pracsys !1849: approved by Børre, GitLab says mergeable, the project lets threads stay open: Merge, threads as information
    const replied = withThreads(open({ ready: true, approved: true, approvedBy: ['Børre'], sha: 'abc1234' }), { replied: 2, repliedTo: ['Børre'] });
    assert.deepEqual([row(replied).next, ...shown(row(replied))], ['Approved by Børre — merge it · 2 open threads', 'ready', 'Merge']);
    // the same MR in a project that requires resolved threads: GitLab won't merge it, so it waits on them, no Merge
    const required = withThreads(open({ ready: false, approved: true, approvedBy: ['Børre'], changes: true, mergeStatus: 'discussions_not_resolved', sha: 'abc1234' }), { replied: 2, repliedTo: ['Børre'] });
    assert.deepEqual([row(required).next, ...shown(row(required))], ['Replied to 2 threads — waiting for Børre to resolve', 'review', null]);
    const unapproved = withThreads(open({ reviewers: ['Ann'] }), { unanswered: 1, unansweredBy: ['Bo'] });
    assert.deepEqual(shown(row(unapproved)), ['needs-you', 'Fix & reply']);
}
// GitHub: no Homebase merge; its chat runs the gate, then merges
{
    const pr = 'https://github.com/o/p/pull/1';
    const x = workItems([{ ...main(), prs: [{ url: pr, at: 1 }] }], () => open({ ready: true }), NOW).find(r => r.pr === pr);
    assert.deepEqual([x.column, x.action?.label], ['ready', 'Merge + close issue']);
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
{
    // the click's own prompt and the helper it set going are the click at work: the hold outlives them
    const clicks = sent(NOW - 1000);
    const prompt = main({ openPrompts: [{ at: new Date(NOW).toISOString(), text: 'Rebase !1 onto its target' }] });
    assert.deepEqual(shown(row(conflict, [prompt], clicks)), ['doing', null]);
    assert.deepEqual(shown(row(conflict, [main({ agents: [helper()] })], clicks)), ['doing', null]);
    const after = row(conflict, [main()], clicks);
    assert.deepEqual([...shown(after), /^Sent to Claude \(/.test(after.next)], ['doing', null, true], '7 still held once the turn ended');
    // a Continue on an MR row outlives its own prompt, and ends once the helper runs again
    const stoppedMr = helper({ status: 'stopped', stopReason: 'api-error', updated: NOW - 5000 });
    const contHeld = new Map([[url, { at: NOW - 1000, kind: 'api-error' }]]);
    row(open({ reviewers: ['Ann'] }), [main({ agents: [stoppedMr], openPrompts: [{ at: new Date(NOW).toISOString(), text: "The subagent 'Fix !1' stopped — continue it" }] })], contHeld);
    assert.deepEqual(shown(row(open({ reviewers: ['Ann'] }), [main({ agents: [stoppedMr] })], contHeld)), ['doing', null], 'still held after its prompt');
    // a Continue ends once the helper runs again
    const cont = new Map([[url, { at: NOW - 1000, kind: 'api-error' }]]);
    row(open({ reviewers: ['Ann'] }), [main({ agents: [helper()] })], cont);
    assert.equal(cont.size, 0, 'a running helper ends a Continue');
    // Review and Merge claims sit under their own keys: no hold
    assert.deepEqual(shown(row(open({ reviewers: ['Ann'] }), [main()], new Map([[`review:${url}`, { at: NOW - 1000, kind: 'in-review' }]]))), ['review', 'Review']);
    assert.deepEqual(shown(row(open({ ready: true, sha: 'abc1234' }), [main()], new Map([[`merge:${url}`, { at: NOW - 1000, kind: 'abc1234' }]]))), ['ready', 'Merge']);
}
assert.match(row(conflict, [main(), asks]).next, /^Asks: !1: keep both migrations\? · /, '3 the question leads the text');
{
    // a running helper leads, however quiet, over a newer finished or stopped one
    const failing = open({ ci: 'failing' });
    const quiet = helper({ id: 'r', updated: NOW - 300_000 });
    assert.deepEqual(shown(row(failing, [main({ agents: [quiet, helper({ id: 'd', status: 'done', updated: NOW - 1000 })] })])), ['doing', null]);
    assert.deepEqual(shown(row(failing, [main({ agents: [quiet, helper({ id: 's', status: 'stopped', stopReason: 'api-error', updated: NOW - 1000 })] })])), ['doing', null]);
    // the same failure coming back while a chat worked on it ends the click: the button is back once the chat is idle
    const clicks = new Map([[url, { at: NOW - 600_000, kind: 'failing' }]]);
    const onBranch = st => chat({ status: st, head: '1-x' });
    row(open({ ci: 'running', branch: '1-x' }), [main(), onBranch('working')], clicks);
    row(open({ ci: 'failing', branch: '1-x' }), [main(), onBranch('working')], clicks);
    assert.deepEqual(shown(row(open({ ci: 'failing', branch: '1-x' }), [main(), onBranch('idle')], clicks)), ['needs-you', 'Fix pipeline']);
    // the held text says when the button is back
    assert.match(row(conflict, [main()], sent(NOW - 1000)).next, /^Sent to Claude \(.+\) · button back at /);
}
{
    // no forge answer yet: a chat's own report and a Continue still count
    const doing = chat({ status: 'working', report: { phase: 'doing', mr: '!1', text: 'Rebasing', at: 5 } });
    assert.deepEqual([...shown(row(null, [main(), doing])), row(null, [main(), doing]).next], ['doing', null, 'Rebasing']);
    const waits = chat({ status: 'waiting', report: { phase: 'needs-you', mr: '!1', text: 'Which?', at: 5 } });
    assert.equal(row(null, [main(), waits]).column, 'needs-you');
    const stopped = main({ agents: [helper({ status: 'stopped', stopReason: 'api-error' })] });
    assert.deepEqual(shown(row(null, [stopped], new Map([[url, { at: NOW - 1000, kind: 'api-error' }]]))), ['doing', null], 'Continue holds without a forge answer');
    assert.match(row(null, [main()], new Map(), () => 'not logged in').next, /not logged in/, '9 says why the lookup failed');
}
{
    // two running helpers: the first started leads, whoever wrote last; activity lists the others, never the lead
    const r1 = helper({ id: 'r1', started: 1, updated: NOW - 5 }), r2 = helper({ id: 'r2', started: 2, updated: NOW - 1 });
    const lead = x => [x.agentId, x.activity.map(a => a.id)];
    assert.deepEqual(lead(row(open(), [main({ agents: [r1, r2] })])), ['r1', ['r2']]);
    assert.deepEqual(lead(row(open(), [main({ agents: [{ ...r1, updated: NOW }, r2] })])), ['r1', ['r2']]);
    const s1 = helper({ id: 's1', status: 'stopped', stopReason: 'api-error', updated: NOW });
    assert.deepEqual(lead(row(open(), [main({ agents: [s1, helper({ id: 'q', updated: NOW - 300_000 })] })])), ['q', ['s1']]);
    // a helper that stopped after the click shows its Continue, not the hold
    const later = main({ agents: [helper({ status: 'stopped', stopReason: 'api-error', updated: NOW - 500 })] });
    assert.deepEqual(shown(row(conflict, [later], sent(NOW - 1000))), ['needs-you', 'Continue']);
    // a helper that finished since the click says how it went in the held text
    const fin = main({ agents: [helper({ status: 'done', outcome: 'Pipeline fails on a missing CI secret.', updated: NOW - 500 })] });
    assert.match(row(conflict, [fin], sent(NOW - 1000)).next, /^Sent to Claude \(.+\) · Helper finished: Pipeline fails on a missing CI secret · button back at /);
    // an MR button's click without a forge answer holds too
    assert.deepEqual(shown(row(null, [main()], sent(NOW - 1000))), ['doing', null]);
}
{
    // a PR that needs no review, with replied threads: Ready, not Approved, and mergeable
    const x = row(open({ ready: true, approved: false, replied: 1, repliedTo: ['Bo'], sha: 'abc1234' }));
    assert.deepEqual([x.next, ...shown(x)], ['Ready — merge it · 1 open thread', 'ready', 'Merge']);
}
{
    // texts that say what the button does, and who acts
    assert.equal(row(open({ reviewers: ['Ann'] }), [main({ agents: [helper({ status: 'stopped' })] })]).next, 'Helper stopped — Continue resumes it');
    assert.equal(row(open({ ready: true, approved: true, replied: 2, repliedTo: ['Ann'] })).next, 'Approved — merge it · 2 open threads');
    assert.equal(row(open({ ready: true, approved: false })).next, 'Ready — merge it', 'GitHub without a required review: not Approved');
    assert.equal(row(open({ ready: true, approved: false, unanswered: 1, unansweredBy: ['Bo'] })).next, "Reply to Bo's comment", 'unreviewed GitHub PR: no Approved');
    assert.match(row(open({ approved: true, ci: 'running', unanswered: 1, unansweredBy: ['Bo'] })).next, /^Approved — 1 unanswered comment from Bo/);
    const notYet = row(open({ approved: true, approvedBy: ['Ann'] }));
    assert.deepEqual([notYet.next, ...shown(notYet)], ['Approved by Ann — not mergeable yet', 'review', null]);
    assert.equal(row(open({ approved: true, approvedBy: ['Ann'], mergeStatus: 'ci_must_pass' })).next, 'Approved by Ann — not mergeable yet (GitLab: needs a passing pipeline)', 'says why');
    // comments never read: Not checked, but the row keeps its MR's title and its helper
    const unread = row({ ...open({ title: 'Fix login', branch: '1-x', ready: true, approved: true }), unread: true }, [main({ agents: [helper()] })]);
    assert.deepEqual([unread.title, unread.agentId, unread.column], ['Fix login', 'a', 'doing']);
    assert.equal(row({ ...open({ title: 'Fix login', ready: true, approved: true }), unread: true }).column, 'unknown');
    const failed = row({ ...open({ title: 'Fix login' }), unread: true }, [main({ agents: [helper({ status: 'done', outcome: 'Pushed the fix' })] })], new Map(), () => 'comments: timed out');
    assert.match(failed.next, /^Couldn't check the MR: comments: timed out · Helper finished: Pushed the fix/, '9 why the lookup failed stays first');
    // stage follows approval as the texts do
    assert.equal(row(open({ ready: true, approved: false })).stageLabel, 'Review');
    assert.equal(row(open({ ready: true, approved: true })).stageLabel, 'Approved');
}
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
// tied agents on one MR: the same agent leads whatever order they come in
{
    const a = helper({ id: 'a1', status: 'stopped', stopReason: 'api-error', updated: 5 }), b = helper({ id: 'b1', status: 'done', updated: 5 });
    const key = agents => JSON.stringify(shown(row(open({ reviewers: ['Ann'] }), [main({ agents })])));
    assert.equal(key([a, b]), key([b, a]));
}
console.log('ok same inputs, same rows');
// since: an MR's creation on the forge, a helper's start
{
    assert.equal(row(open({ createdAt: 42 })).since, 42);
    assert.equal(row(open()).since, null, 'no creation date: sessions.mjs fills in when it was first seen');
    const x = workItems([{ ...main(), prs: [], agents: [helper({ prs: [], description: 'Tidy', started: 7 })] }], () => null, NOW).find(r => !r.pr);
    assert.equal(x.since, 7);
}

// order inside a group: when the row first appeared, never its last activity
{
    const rows = [{ key: 'a', since: 1, updated: 99 }, { key: 'b', since: 3, updated: 2 }, { key: 'c', since: null, updated: 2 }, { key: 'd', since: 3, updated: 50 }];
    assert.deepEqual(rows.toSorted(byStart).map(r => r.key), ['b', 'd', 'c', 'a']);
}
console.log('ok order by first appearance');

// Merge only at the head the user confirmed
{
    const ready = row(open({ ready: true, sha: 'abc1234' }));
    assert.equal(mergeRefusal(ready, 'abc1234'), null);
    assert.match(mergeRefusal(ready, 'def5678'), /changed since you clicked/, 'a push after the dialog opened');
    assert.match(mergeRefusal(ready, null), /changed since you clicked/, 'no head sent');
    assert.match(mergeRefusal(row(open({ reviewers: ['Ann'] })), 'abc1234'), /no Merge button/);
}
console.log('ok merge only at the confirmed head');
