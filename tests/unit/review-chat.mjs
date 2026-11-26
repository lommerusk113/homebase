// The review chat's row action: in review -> Review -> Reviewing… -> Send findings, from real summarize() of fixture transcripts.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarize, workItems } from '../../server.mjs';
import { reviewAction, REVIEWER_START_MS, reviewers } from '../../server/items.mjs';
import { loadReviewers, startReviewer, markFindingsSent, REVIEW_PROMPT } from '../../server/reviewer.mjs';
import { open, mr, now } from './helpers.mjs';

const at = s => new Date(now - s * 1000).toISOString();
const base = { isSidechain: false, cwd: '/x/alpha', sessionId: 'rev', gitBranch: 'feat' };
const entries = list => list.map(e => ({ ...base, ...e }));
const prompt = { type: 'user', timestamp: at(60), origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'Run review-gate' } };
const tool = { type: 'assistant', timestamp: at(50), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git diff' } }] } };
const said = text => ({ type: 'assistant', timestamp: at(20), message: { content: [{ type: 'text', text }] } });
const end = { type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(19) };
const sess = (list, age) => ({ id: 'rev', project: 'p', agents: [], prs: [], ...summarize(entries(list), age * 1000) });

const FINDINGS = '| # | finding |\n|---|---|\n| 1 | none |\n\n**Verdict: ready**';
const r = { id: 'rev', at: now - 100_000, sent: false };

// no reviewer, or its findings already sent: Review
assert.equal(reviewAction(undefined, undefined, now).kind, 'review');
assert.equal(reviewAction({ ...r, sent: true }, sess([prompt, said(FINDINGS), end], 19), now).label, 'Review');
// after sent: only a moved head under the cap brings Review back; the cap leaves a quiet note
const sentOnce = { ...r, sent: true, sha: 'aaa1111', rounds: 1 };
assert.equal(reviewAction(sentOnce, undefined, now, 'aaa1111222'), null, 'same head: no button');
assert.equal(reviewAction(sentOnce, undefined, now, 'bbb2222').label, 'Review', 'new head, round 1');
assert.deepEqual(reviewAction({ ...sentOnce, rounds: 2 }, undefined, now, 'bbb2222'), { note: 'Reviewed twice' });
// started, no transcript yet: Reviewing…; but not forever
assert.equal(reviewAction(r, undefined, now).label, 'Reviewing…');
assert.equal(reviewAction(r, undefined, r.at + REVIEWER_START_MS + 1).label, 'Review');
// mid-turn: Reviewing…, with the chat to open
assert.deepEqual(reviewAction(r, sess([prompt, tool], 5), now), { label: 'Reviewing…', kind: 'reviewing', message: 'The reviewer is working', reviewerId: 'rev' });
// finished: Send findings with the final message
const done = reviewAction(r, sess([prompt, tool, said('thinking'), tool, said(FINDINGS), end], 19), now);
assert.equal(done.label, 'Send findings');
assert.equal(done.message, `Review findings from a fresh reviewer:\n\n${FINDINGS}\n\nAddress them.`);
assert.equal(reviewAction(r, sess([prompt, said('x'.repeat(30_000)), end], 19), now).message.length < 20 * 1024, true, 'stays under the send cap');
console.log('ok review action');

// through workItems: only an in-review row, the reviewer chat is no row of its own, and the working chat gets the button
const master = { id: 'm', project: 'p', status: 'idle', prs: [{ url: mr(4), at: now }], agents: [] };
const rows = (map, rev) => workItems([master, ...(rev ? [rev] : [])], () => open({ reviewers: ['Ann'] }), now, undefined, [], map);
assert.deepEqual([rows(new Map())[0].column, rows(new Map())[0].action.label], ['review', 'Review']);
assert.equal(rows(new Map([[mr(4), r]]), sess([prompt, tool], 5)).length, 1);
assert.equal(rows(new Map([[mr(4), r]]), sess([prompt, tool], 5))[0].action.label, 'Reviewing…');
assert.equal(rows(new Map([[mr(4), r]]), sess([prompt, said(FINDINGS), end], 19))[0].action.label, 'Send findings');
assert.equal(workItems([master], () => open(), now, undefined, [], new Map())[0].action.label, 'Request review', 'no reviewer asked yet: that comes first');
assert.equal(workItems([master], () => open({ ready: true, reviewers: ['Ann'] }), now, undefined, [], new Map())[0].action.label, 'Merge');
console.log('ok review rows');

// starting one: fixed prompt, own tmux, one per row
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-rev-'));
    const calls = [];
    const tm = async args => { calls.push(args); };
    const id = '11111111-2222-4333-8444-555555555555';
    reviewers.clear();
    assert.equal(await startReviewer(dir, { key: mr(4), cwd: '/x/alpha', gitlab: true }, { tm, now, newId: () => id }), id);
    assert.deepEqual(calls[0].slice(0, 6), ['new-session', '-d', '-s', 'cc-11111111', '-c', '/x/alpha']);
    assert.ok(calls[0].at(-1).includes(`--disallowedTools 'Edit Write NotebookEdit' --session-id ${id} '${REVIEW_PROMPT.work}'`), 'edit tools denied, prompt still last');
    assert.ok(calls[0].at(-1).includes(`--session-id ${id} '${REVIEW_PROMPT.work}'`));
    assert.ok(REVIEW_PROMPT.work.startsWith('Run review-gate on this branch against its MR target. Read-only'));
    await startReviewer(dir, { key: 'gh', cwd: '/x/t', gitlab: false }, { tm, now, newId: () => id });
    assert.ok(calls[1].at(-1).includes('Run /code-review on this branch'));
    await assert.rejects(startReviewer(dir, { key: mr(4), cwd: '/x/alpha', gitlab: true }, { tm, now }), { status: 409 });
    assert.equal(calls.length, 2);
    await markFindingsSent(dir, mr(4));
    await startReviewer(dir, { key: mr(4), cwd: '/x/alpha', gitlab: true }, { tm, now, newId: () => id.replace('1', '2') });
    await assert.rejects(startReviewer(dir, { key: '', cwd: '/x' }, { tm }), { status: 400 });
    await assert.rejects(markFindingsSent(dir, 'nope'), { status: 404 });
    // survives a restart
    loadReviewers(dir);
    assert.deepEqual([...reviewers.keys()].sort(), ['gh', mr(4)].sort());
    assert.equal(reviewers.get(mr(4)).sent, false);
    reviewers.clear();
}
console.log('ok review chat start');
