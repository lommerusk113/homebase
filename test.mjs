import assert from 'node:assert/strict';
import { status, summarize, column } from './server.mjs';

assert.equal(column('working', { state: 'merged' }, true), 'doing');
assert.equal(column('idle', { state: 'merged' }, true), 'done');
assert.equal(column('idle', { state: 'open', ready: true }, true), 'ready');
assert.equal(column('idle', { state: 'open', changes: true }, true), 'needs-you');
assert.equal(column('waiting', null, true), 'review');
assert.equal(column('waiting', null, false), 'needs-you');
assert.equal(column('idle', null, false), 'idle');

assert.equal(status({ type: 'assistant' }, 1_000), 'working');
assert.equal(status({ type: 'assistant' }, 60_000), 'waiting');
assert.equal(status({ type: 'user' }, 60_000), 'idle');
assert.equal(status({ type: 'assistant' }, 3_600_000), 'idle');

const s = summarize([
    { type: 'user', cwd: '/r', gitBranch: 'b', sessionId: 'x', message: { content: 'fix it' } },
    { type: 'user', isMeta: true, message: { content: 'meta' } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'r' }] } },
    { type: 'ai-title', aiTitle: 'Fix' },
    { type: 'pr-link', prUrl: 'https://pr/1' },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'done' }] } }
], 60_000);
assert.deepEqual(
    [s.id, s.branch, s.title, s.pr, s.model, s.status, s.lastPrompt, s.lastReply],
    ['x', 'b', 'Fix', 'https://pr/1', 'm', 'waiting', 'fix it', 'done']
);

console.log('ok');

import { filesTouched } from './server.mjs';
assert.deepEqual(filesTouched([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/x.js' } }, { type: 'tool_use', name: 'Write', input: { file_path: '/r/b.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] } }
], '/r'), ['a.js', 'b.js']);
console.log('ok files');

import { summarizeAgent } from './server.mjs';
const a = summarizeAgent({ description: 'Implement #1', finished: true }, [
    { type: 'assistant', gitBranch: 'b1', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'MR open: https://gitlab.com/x/y/-/merge_requests/7.' } }] } }
], 999_999);
assert.deepEqual([a.status, a.pr, a.branch], ['done', 'https://gitlab.com/x/y/-/merge_requests/7', 'b1']);
assert.equal(summarizeAgent({ finished: false }, [], 1_000).status, 'running');
assert.equal(summarizeAgent({ finished: false }, [], 600_000).status, 'stopped');
import { agentStatus } from './server.mjs';
const MIN = 60_000;
const call = (...ids) => ({ type: 'assistant', message: { content: ids.map(id => ({ type: 'tool_use', id, name: 'Bash' })) } });
const result = id => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const ended = { type: 'assistant', message: { content: [{ type: 'text', text: 'Done here.' }] } };
const noise = { type: 'api-request', message: { content: [{ type: 'tool_use', id: 'x' }] } };
const st = (entries, ageMs, meta = {}) => agentStatus(meta, entries, ageMs);
assert.deepEqual(st([ended], 99 * MIN, { finished: true }), { status: 'done' });
assert.equal(st([call('a')], 25 * MIN).status, 'running'); // long Bash
assert.equal(st([call('a'), noise], 31 * MIN).status, 'stopped'); // pending call capped; non-turn entries ignored
assert.equal(st([call('a', 'b'), result('a')], 25 * MIN).status, 'running'); // parallel call b still pending
assert.equal(st([call('a'), result('a')], 9 * MIN).status, 'running'); // thinking
assert.equal(st([call('a'), result('a')], 11 * MIN).status, 'stopped');
assert.equal(st([call('a'), result('a'), ended], 1 * MIN).status, 'running');
assert.equal(st([call('a'), result('a'), ended], 3 * MIN).status, 'stopped'); // ended its turn without handing back
assert.equal(st([call('old'), result('x'), ended], 3 * MIN).status, 'stopped'); // an unanswered call from an earlier turn is not pending
assert.deepEqual(st([call('a'), result('a'), { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } }], 1_000), { status: 'stopped', stopReason: 'api-error' });
console.log('ok agents');

import { splitTldr, toolSummary, chatItems, pendingQuestion, sendSteps } from './server.mjs';
assert.deepEqual(splitTldr('Long text.\n\n**TLDR:** It works.'), { tldr: 'It works.', text: 'Long text.' });
assert.equal(splitTldr('a\n**TLDR**: fixed **now**').tldr, 'fixed **now**');
assert.equal(splitTldr('**TL;DR: shipped**').tldr, 'shipped');
assert.equal(splitTldr('we use tldraw here').tldr, null);
assert.equal(splitTldr('a\nTLDR: plain').tldr, 'plain');
assert.equal(splitTldr('a\ntldr: lower').tldr, 'lower');
assert.equal(splitTldr('a\n**TLDR:** bold label').tldr, 'bold label');
assert.deepEqual(splitTldr('Intro.\n\nTLDR: first\n\nTLDR: last\n\nTrailing note.'), { tldr: 'last', text: 'Intro.\n\nTLDR: first\n\n\n\nTrailing note.' });
assert.equal(toolSummary([
    { name: 'Bash' }, { name: 'Bash' }, { name: 'Bash' },
    { name: 'Edit', input: { file_path: '/a' } }, { name: 'Edit', input: { file_path: '/a' } }, { name: 'Write', input: { file_path: '/b' } },
    { name: 'Agent' }, { name: 'Agent' }, { name: 'TodoWrite' }
]), 'Ran 3 commands · edited 2 files · started 2 agents · used 1 other tool');
const tu = (name, extra) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, ...extra }] } });
const say = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const chat = chatItems([
    { type: 'user', message: { content: 'do it' } },
    say('On it.'), tu('Bash'), tu('Read'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] } },
    say('Done.'), say('TLDR: shipped'),
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'side' }] } }
]);
assert.deepEqual(chat.map(i => [i.role, i.text, i.tldr]), [
    ['user', 'do it', undefined], ['assistant', 'On it.', null], ['tools', 'Ran 1 command · read 1 file', undefined], ['assistant', 'Done.', 'shipped']
]);
const q = tu('AskUserQuestion', { id: 'q1', input: { questions: [{ question: 'Which?' }] } });
assert.equal(pendingQuestion([q]), 'Which?');
assert.equal(pendingQuestion([q, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q1' }] } }]), null);
assert.deepEqual(sendSteps('cc-1', ' hi\x1b \r\n'), [['send-keys', '-t', 'cc-1', '-l', '--', 'hi'], ['send-keys', '-t', 'cc-1', 'Enter']]);
assert.equal(sendSteps('cc-1', 'a\r\nb')[0].at(-1), 'a\nb');
assert.throws(() => sendSteps('cc-1', ' \n '));
console.log('ok chat');

import { agentStage } from './server.mjs';
const bash = command => ({ name: 'Bash', input: { command } });
assert.equal(agentStage([{ name: 'Read' }, bash('ls')], '', false), 0);
assert.equal(agentStage([{ name: 'Edit' }], '', false), 1);
assert.equal(agentStage([{ name: 'Edit' }, bash('./gradlew check')], '', false), 2);
assert.equal(agentStage([bash('npm run typecheck')], '', false), 2);
assert.equal(agentStage([bash('git push -u origin x'), bash('npx vitest run')], '', false), 3);
assert.equal(agentStage([], 'MR: https://gitlab.com/a/b/-/merge_requests/3', false), 3);
assert.equal(agentStage([], '', true), 4);
assert.equal(summarizeAgent({ finished: false }, [tu('Write')], 1_000).stageLabel, 'Implement');
assert.equal(agentStage([bash('cd /r && git push')], '', false), 3);
assert.equal(agentStage([bash('npm run build; npm test')], '', false), 2);
assert.equal(agentStage([bash('cat > t.sh <<\'EOF\'\ngit push origin x\nEOF')], '', false), 0);
assert.equal(agentStage([bash('node -e "assert(run(\'git push\'))"')], '', false), 0);
assert.equal(agentStage([bash('echo git push')], '', false), 0);
assert.equal(agentStage([bash('git commit -m "$(cat <<\'EOF\'\nadd test, then git push\nEOF\n)"')], '', false), 0);
assert.equal(summarizeAgent({ finished: false }, [tu('Edit')], 1_000, 'agent-peak').stage, 1);
assert.equal(summarizeAgent({ finished: false }, [tu('Read')], 1_000, 'agent-peak').stage, 1); // edit fell out of the tail
assert.equal(summarizeAgent({ finished: false }, [tu('Read')], 1_000, 'agent-other').stage, 0);
console.log('ok stage');

import { refuseIfLiveElsewhere } from './server.mjs';
assert.throws(() => refuseIfLiveElsewhere(60_000), { status: 409, message: /open in another terminal/ });
assert.doesNotThrow(() => refuseIfLiveElsewhere(180_000));
console.log('ok send guard');

const queued = chatItems([
    { type: 'user', message: { content: 'start' }, timestamp: 't0' },
    { type: 'queue-operation', operation: 'enqueue', content: 'also do B', timestamp: 't1' },
    { type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', content: 'also do B', commandUuid: 'c1', timestamp: 't2' },
    { type: 'attachment', timestamp: 't2', attachment: { type: 'queued_command', prompt: 'also do B', origin: { kind: 'human' }, humanTurn: true, source_uuid: 'c1' } },
    { type: 'attachment', timestamp: 't2', attachment: { type: 'queued_command', prompt: '<task-notification>', origin: { kind: 'task-notification' } } },
    say('Did A and B.'),
    { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>x', timestamp: 't3' },
    { type: 'queue-operation', operation: 'enqueue', content: 'now C', timestamp: 't4' }
]);
assert.deepEqual(queued.map(i => [i.role, i.text, i.at, i.pending]), [
    ['user', 'start', 't0', undefined], ['user', 'also do B', 't2', undefined], ['assistant', 'Did A and B.', undefined, undefined], ['user', 'now C', 't4', true]
]);
assert.equal(chatItems([
    { type: 'queue-operation', operation: 'enqueue', content: 'x', timestamp: 't1' },
    { type: 'queue-operation', operation: 'dequeue', timestamp: 't2' },
    { type: 'user', message: { content: 'x' }, timestamp: 't2' }
]).length, 1);
console.log('ok queued');

import { unwrapPasted } from './server.mjs';
const paste = (id, text) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
assert.equal(unwrapPasted(`\n\n${paste('abc1', 'line one\nline two')}`), 'line one\nline two');
assert.equal(unwrapPasted(`see:\n${paste('a', 'X')}\nand ${paste('b', 'Y')} done`), 'see:\nX\nand Y done');
const T = s => `2026-11-12T22:11:${s}Z`;
const pasted = chatItems([
    { type: 'user', message: { content: `\n\n${paste('abc1', 'why does it\nshow merged')}` }, timestamp: T('00.000') },
    { type: 'queue-operation', operation: 'enqueue', content: paste('q1', 'queued\npaste'), timestamp: T('05.000') },
    { type: 'queue-operation', operation: 'remove', content: paste('q1', 'queued\npaste'), timestamp: T('06.000') },
    { type: 'attachment', timestamp: T('04.900'), attachment: { type: 'queued_command', prompt: paste('q1', 'queued\npaste'), origin: { kind: 'human' } } },
    { type: 'queue-operation', operation: 'enqueue', content: paste('q2', 'still\nwaiting'), timestamp: T('09.000') }
]);
assert.deepEqual(pasted.map(i => [i.text, i.pending]), [['why does it\nshow merged', undefined], ['queued\npaste', undefined], ['still\nwaiting', true]]);
// one message as prompt + queued attachment + pending enqueue renders once; the same text much later still shows
const dup = chatItems([
    { type: 'user', message: { content: 'ship it' }, timestamp: T('00.000') },
    { type: 'attachment', timestamp: T('01.000'), attachment: { type: 'queued_command', prompt: 'ship  it', origin: { kind: 'human' } } },
    { type: 'queue-operation', operation: 'enqueue', content: 'ship it\n', timestamp: T('02.000') },
    { type: 'user', message: { content: 'ship it' }, timestamp: '2026-11-12T23:00:00.000Z' }
]);
assert.deepEqual(dup.map(i => [i.text, i.at]), [['ship it', T('00.000')], ['ship it', '2026-11-12T23:00:00.000Z']]);
console.log('ok pasted + dedupe');
import { nextStep, workItems } from './server.mjs';
const open = extra => ({ state: 'open', reviewers: [], ...extra });
assert.equal(nextStep({ state: 'merged' }, { status: 'running', stage: 1 }), 'Merged');
assert.equal(nextStep(open(), { status: 'running', stage: 2, description: 'Rebase !7' }), 'Rebase !7 is verifying…');
assert.equal(nextStep(null, { status: 'stopped' }), 'Agent stopped — check the chat');
assert.equal(nextStep(null, { status: 'stopped', stopReason: 'api-error' }), 'Agent hit an API error — continue it');
assert.equal(nextStep(open({ changes: true, reviewers: ['Ann'] }), null), 'Address review comments from Ann');
assert.equal(nextStep(open({ changes: true, reviewers: ['Ann'], changesBy: ['bob'] }), null), 'Address review comments from bob');
assert.equal(nextStep(open({ reviewers: ['Ann', 'Bo'] }), { status: 'done' }), 'Waiting for review by Ann, Bo');
assert.equal(nextStep(open(), null), 'Needs a reviewer');
assert.equal(nextStep(open({ ready: true }), null), 'Approved — merge it');
assert.equal(nextStep(open({ ci: 'failing' }), null), 'Pipeline failing');
assert.equal(nextStep(open({ ci: 'running' }), null), 'Pipeline running');
console.log('ok next');

const mr = n => `https://gitlab.com/g/p/-/merge_requests/${n}`;
const agent = (id, updated, extra) => ({ id, updated, status: 'done', stage: 4, prs: [], description: id, ...extra });
const items = workItems([
    { id: 's1', project: 'p', prs: [{ url: mr(1), at: 10 }, { url: mr(2), at: 20 }], agents: [
        agent('impl1', 5, { prs: [mr(1)], tldr: 'old' }),
        agent('fix1', 30, { description: 'Address comments on !1', tldr: 'new' }),
        agent('sim', 40, { description: 'Simulate accountant' }),
        agent('wip', 50, { status: 'running', stage: 1, description: 'Implement #9' })
    ] },
    { id: 's2', project: 'p', prs: [{ url: mr(2), at: 25 }], agents: [] }
], url => (url === mr(1) ? { state: 'merged', title: 'One' } : open({ reviewers: ['Ann'] })));
assert.deepEqual(items.map(i => [i.key, i.sessionId, i.column, i.stageLabel, i.updated]), [
    [mr(1), 's1', 'done', 'Merged', 30],
    [mr(2), 's2', 'review', 'Review', 25],
    ['wip', 's1', 'doing', 'Implement', 50]
]);
assert.deepEqual([items[0].title, items[0].tldr, items[0].activity.map(x => x.id)], ['One', 'new', ['impl1']]);
assert.equal(items[1].next, 'Waiting for review by Ann');
console.log('ok items');

import { tmuxArgs } from './server.mjs';
assert.deepEqual(tmuxArgs(['send-keys', '-t', 'cc-1', 'Escape'], undefined), ['send-keys', '-t', 'cc-1', 'Escape']);
assert.deepEqual(tmuxArgs(['has-session'], 'hbtest'), ['-L', 'hbtest', 'has-session']);
console.log('ok tmux socket');

import { repoName } from './server.mjs';
assert.equal(repoName('github-personal:lommerusk113/homebase.git\n'), 'homebase');
assert.equal(repoName('git@gitlab.com:tritt/accounting/pracsys.git'), 'pracsys');
assert.equal(repoName('https://github.com/contaas/portal-frontend'), 'portal-frontend');
console.log('ok repo name');
import { yourMove } from './server.mjs';
const mv = (...a) => yourMove(...a)?.action ?? null;
assert.equal(mv('ready', open({ ready: true, reviewers: ['Ann'] }), null), 'merge');
assert.equal(mv('needs-you', open({ changes: true, ci: 'failing' }), 'stopped'), 'address comments on');
assert.equal(mv('review', open({ ci: 'failing', reviewers: ['Ann'] }), null), 'fix pipeline on');
assert.equal(mv('needs-you', null, 'stopped'), 'check stopped agent');
assert.equal(mv('review', open(), 'done'), 'assign a reviewer on');
assert.equal(mv('review', open({ reviewers: ['Ann'] }), null), null);
assert.equal(mv('review', open({ draft: true }), null), null);
assert.equal(mv('doing', open({ changes: true }), 'running'), null);
assert.equal(mv('done', { state: 'merged' }, null), null);
assert.deepEqual(items.map(i => i.move), [null, null, null]);
assert.deepEqual(['ready', 'needs-you', 'review'].map(c => yourMove(c, open({ ready: c === 'ready', changes: c === 'needs-you' }), null).rank), [1, 2, 5]);
console.log('ok your move');
import { rowAction } from './server.mjs';
const act = (prState, agent, url = mr(4)) => rowAction(url, prState, agent, 'T');
assert.deepEqual(act(open({ ready: true, reviewers: ['Ann'] }), null), { label: 'Merge + close issue', message: `Merge !4 (${mr(4)}) and close its issue.` });
assert.deepEqual(act(open({ changes: true, reviewers: ['Ann'] }), { status: 'stopped' }), { label: 'Fix & reply', message: `Address the review comments on !4 (${mr(4)}), push, and reply in each thread.` });
assert.deepEqual(act(open({ ci: 'failing', reviewers: ['Ann'] }), null), { label: 'Fix pipeline', message: `The pipeline on !4 (${mr(4)}) is failing — find out why and fix it.` });
assert.deepEqual(act(open(), { status: 'done' }), { label: 'Request review', message: `Assign a reviewer to !4 (${mr(4)}) — suggest who.` });
assert.equal(act(open(), null, 'https://github.com/o/r/pull/9').message, 'Assign a reviewer to #9 (https://github.com/o/r/pull/9) — suggest who.');
assert.deepEqual(rowAction(null, null, { status: 'stopped' }, 'Implement #9'), { label: 'Continue', message: "The subagent 'Implement #9' stopped — check why and continue it." });
assert.equal(rowAction(null, null, { status: 'running' }, 'x'), null); // doing
assert.equal(act(open({ ready: true }), { status: 'running' }), null); // doing
assert.equal(act(open({ reviewers: ['Ann'] }), null), null); // waiting on review
assert.equal(act({ state: 'merged' }, null), null);
assert.equal(act(open({ draft: true }), null), null);
assert.equal(act(null, null), null); // state unknown
assert.equal(items[1].action, null);
console.log('ok actions');

import { sameRepo } from './server.mjs';
assert.equal(sameRepo('https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1590', 'pracsys'), true);
assert.equal(sameRepo('https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1590', 'homebase'), false);
assert.equal(sameRepo('https://github.com/lommerusk113/homebase/pull/3', 'homebase'), true);
console.log('ok same repo');
import { attentionEvents } from './public/list.js';
const it = (key, column, ci) => ({ key, column, prState: ci ? { ci } : null });
const ev = (prev, next) => attentionEvents(prev, next).map(e => [e.kind, e.item.key]);
assert.deepEqual(ev(null, [it('a', 'needs-you')]), []); // first load
assert.deepEqual(ev([it('a', 'review')], [it('a', 'needs-you')]), [['needs-you', 'a']]);
assert.deepEqual(ev([it('a', 'needs-you')], [it('a', 'needs-you')]), []);
assert.deepEqual(ev([it('a', 'review')], [it('a', 'ready')]), [['ready', 'a']]);
assert.deepEqual(ev([it('a', 'doing')], [it('a', 'ready')]), [['ready', 'a']]); // one event per item
assert.deepEqual(ev([it('a', 'doing'), it('b', 'doing')], [it('a', 'review'), it('b', 'done')]), [['finished', 'a'], ['finished', 'b']]);
assert.deepEqual(ev([it('a', 'doing')], []), [['finished', 'a']]); // agent without an MR drops off
assert.deepEqual(ev([it('a', 'review')], []), []);
assert.deepEqual(ev([it('a', 'review')], [it('a', 'review', 'failing')]), [['failing', 'a']]);
assert.deepEqual(ev([it('a', 'review', 'failing')], [it('a', 'review', 'failing')]), []);
assert.deepEqual(ev([], [it('n', 'needs-you'), it('m', 'review')]), [['needs-you', 'n']]);
console.log('ok attention');
import { quickReplies, pendingAsk } from './server.mjs';
const YN = ['Yes', 'No'], YBN = ['Yes', 'Do both', 'No'];
assert.deepEqual(quickReplies('Want me to commit?', 'Fixed it.'), YN);
assert.deepEqual(quickReplies(null, 'Fixed the parser.\n\nShall I push it?'), YN);
assert.deepEqual(quickReplies('Fixed.', 'Done.\n\nWant me to **also** update the docs?'), YN);
assert.deepEqual(quickReplies('**Fix the parser or the renderer?**', 'Two causes.'), YBN);
assert.deepEqual(quickReplies(null, 'Two ways.\n\nShould I go with A, or B?'), YBN);
assert.deepEqual(quickReplies('Commit it or not?', ''), YN);
assert.deepEqual(quickReplies('Fixed the crash.', 'Why did it fail? A stale cache.\n\nCleared it.'), []); // rhetorical, mid-body
assert.deepEqual(quickReplies(null, 'He asked "should we ship?"'), []); // quoted
assert.deepEqual(quickReplies(null, 'Done.\n\n> Can we skip this?'), []);
assert.deepEqual(quickReplies(null, '```\nwhat?\n```'), []);
assert.deepEqual(quickReplies(null, 'Open points:\n- Rename it?\n- Drop the flag?'), []); // several questions
assert.deepEqual(quickReplies(null, ''), []);
assert.deepEqual(chatItems([say('Done.\n\nShip it?')]).at(-1).replies, YN);
assert.equal(chatItems([say('Ship it?'), { type: 'user', message: { content: 'yes' } }])[0].replies, undefined);
assert.equal(chatItems([say('Ship it?'), tu('Bash')])[0].replies, undefined);
const ask2 = tu('AskUserQuestion', { id: 'q2', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite' }] }] } });
assert.deepEqual(pendingAsk([ask2]), [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }]);
assert.equal(pendingAsk([ask2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] } }]), null);
assert.equal(pendingQuestion([tu('AskUserQuestion', { id: 'q3', input: {} })]), 'Claude asked a question.');
console.log('ok quick replies');

import { addUsage, readUsage, formatDuration, formatTokens, limitsOf } from './server.mjs';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
const use = (id, input, output, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 } } });
const u = addUsage({ byId: new Map() }, [use('m1', 2, 30, T('00.000')), use('m1', 2, 30, T('01.000')), use('m2', 5, 7, T('09.000')), `{"type":"user","timestamp":"${T('10.000')}"}`].join('\n'));
assert.deepEqual(u.totals, { input: 7, output: 37, cacheRead: 200, cacheWrite: 20 });
assert.equal(u.last - u.first, 10_000);
const uf = `${mkdtempSync(`${tmpdir()}/hb-`)}/agent.jsonl`;
writeFileSync(uf, use('a', 1, 1, T('00.000')) + '\n' + use('b', 1, 1, T('01.000')).slice(0, 20)); // second line half-written
assert.equal((await readUsage(uf)).output, 1);
appendFileSync(uf, use('b', 1, 1, T('01.000')).slice(20) + '\n' + use('b', 1, 1, T('01.000')) + '\n' + use('c', 1, 4, T('02.000')) + '\n');
assert.deepEqual(await readUsage(uf), { input: 3, output: 6, cacheRead: 300, cacheWrite: 30, first: Date.parse(T('00.000')), last: Date.parse(T('02.000')) });
assert.equal((await readUsage(uf)).output, 6); // unchanged file: nothing re-counted
assert.equal(formatDuration(14 * 60_000), '14m');
assert.equal(formatDuration(20_000), '<1m');
assert.equal(formatDuration(65 * 60_000), '1h 05m');
assert.equal(formatTokens(1_234_567), '1.2M tok');
assert.equal(formatTokens(48_000), '48k tok');
assert.equal(formatTokens(950), '950 tok');
const now = 1_738_400_000_000;
assert.deepEqual(limitsOf({ rate_limits: { five_hour: { used_percentage: 34, resets_at: 1738425600 }, seven_day: { used_percentage: 12.5, resets_at: 1738857600 } } }, now),
    { fiveHour: { used: 34, resetsAt: 1738425600_000 }, sevenDay: { used: 12.5, resetsAt: 1738857600_000 } });
assert.equal(limitsOf({ rate_limits: { five_hour: { used_percentage: 34, resets_at: 1738300000 }, seven_day: { used_percentage: 12, resets_at: 1738857600 } } }, now).fiveHour, null); // already reset
assert.equal(limitsOf({ session_id: 'x' }, now), null);
const timed = workItems([{ id: 's', project: 'p', prs: [{ url: mr(5), at: 1 }], agents: [
    agent('a1', 2, { prs: [mr(5)], usage: { input: 1, output: 2, cacheRead: 1_000_000, cacheWrite: 200_000, first: 0, last: 14 * 60_000 } }),
    agent('a2', 3, { description: 'Fix !5', status: 'running', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, first: 100 * 60_000, last: 101 * 60_000 } })
] }], () => open(), 151 * 60_000)[0];
assert.deepEqual([timed.tokens, timed.time], ['1.2M tok', '1h 05m']);
assert.equal(timed.tokensTitle, 'input 1 · output 2 · cache read 1,000,000 · cache write 200,000');
console.log('ok usage + limits');

// "Send now" interrupts: the marker isn't a bubble; it flags the last Claude message before it
const cut = chatItems([
    { type: 'user', message: { content: 'go' } },
    say('Working on A.'), tu('Bash'),
    { type: 'user', message: { content: 'also B' } },
    { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    say('Doing B.'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }, { type: 'text', text: '[Request interrupted by user for tool use]' }] } }
]);
assert.deepEqual(cut.map(i => [i.role, i.text, i.interrupted]), [
    ['user', 'go', undefined], ['assistant', 'Working on A.', true], ['tools', 'Ran 1 command', undefined], ['user', 'also B', undefined], ['assistant', 'Doing B.', true]
]);
assert.equal(chatItems([{ type: 'user', message: { content: '[Request interrupted by user]' } }]).length, 0); // nothing to mark
assert.equal(chatItems([{ type: 'user', message: { content: '[Request interrupted by user] and more' } }])[0].role, 'user'); // only the exact marker
console.log('ok interrupted');

import { peakLimits } from './server.mjs';
const dump = (five, fiveReset, week = 10) => ({ rate_limits: { five_hour: { used_percentage: five, resets_at: fiveReset }, seven_day: { used_percentage: week, resets_at: 1738857600 } } });
const peaks = new Map();
assert.deepEqual(peakLimits(peaks, [dump(70, 1738425600), dump(90, 1738425600)], now), { fiveHour: { used: 90, resetsAt: 1738425600_000 }, sevenDay: { used: 10, resetsAt: 1738857600_000 } });
assert.equal(peakLimits(peaks, [dump(70, 1738425600)], now).fiveHour.used, 90); // a stale dump never lowers it
assert.equal(peakLimits(peaks, [], now).fiveHour.used, 90); // remembered across polls
assert.deepEqual(peakLimits(peaks, [dump(5, 1738443600)], 1738425600_000 + 1).fiveHour, { used: 5, resetsAt: 1738443600_000 }); // new window starts fresh
assert.equal([...peaks.keys()].some(k => k.includes('1738425600000')), false); // expired window dropped
assert.equal(peakLimits(new Map(), [{}], now), null);
import { limitLeft } from './public/core.js';
assert.deepEqual(limitLeft({ used: 30, resetsAt: now + 80 * 60_000 }, now), { left: 70, until: '1h20m' });
assert.deepEqual(limitLeft({ used: 37, resetsAt: now + (4 * 1440 + 22 * 60 + 30) * 60_000 }, now), { left: 63, until: '4d22h' });
assert.deepEqual(limitLeft({ used: 30.5, resetsAt: now + 45 * 60_000 }, now), { left: 70, until: '45m' }); // rounds what is left, like Contado
assert.deepEqual(limitLeft({ used: 104, resetsAt: now - 1 }, now), { left: 0, until: '0m' });
assert.deepEqual(limitLeft({ used: 0, resetsAt: now + 2 * 1440 * 60_000 }, now), { left: 100, until: '2d' });
import { limitView } from './public/core.js';
const thu = new Date(2026, 10, 12, 23, 43).getTime(); // local time, so the reset clock reads the same in any zone
assert.deepEqual(limitView(false, { used: 30, resetsAt: thu + 97 * 60_000 }, thu),
    { label: 'Session', left: 70, text: '70%', tip: '70% left of your 5-hour limit · resets in 1h37m (01:20)' });
assert.deepEqual(limitView(true, { used: 37, resetsAt: new Date(2026, 10, 17, 19, 0).getTime() }, thu),
    { label: 'Week', left: 63, text: '63%', tip: '63% left of your weekly limit · resets in 4d19h (Tue 19:00)' });
assert.equal(limitView(false, { used: 81, resetsAt: thu + 97 * 60_000 }, thu).text, '19% · resets 1h37m'); // countdown inline only under 20%
assert.equal(limitView(false, { used: 80, resetsAt: thu + 97 * 60_000 }, thu).text, '20%');
console.log('ok limit peaks');

import { repoPath, groupIssues, milestoneOf, activeMilestones, keepMilestone, worksOn } from './server.mjs';
import { inMilestone } from './public/milestone.js';
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
const row = (pr, milestone) => ({ pr, milestone });
assert.equal(inMilestone(row('u', { id: 7, title: 'S' }), { id: 7 }), true);
assert.equal(inMilestone(row('u', { id: 8, title: 'R' }), { id: 7 }), false);
assert.equal(inMilestone(row('u', null), { id: 7 }), false);
assert.equal(inMilestone(row(null, null), { id: 7 }), true); // an agent without an MR stays
assert.equal(inMilestone(row('u', null), null), true); // no milestone selected
console.log('ok milestones');

import { chatStatus } from './public/core.js';
assert.equal(chatStatus(null).kind, 'idle');
assert.equal(chatStatus({ working: true, asking: 'Pick one?', items: [] }).kind, 'asking'); // asking wins
const askedAt = new Date(now - 125 * 60_000).toISOString();
assert.equal(chatStatus({ working: true, items: [{ role: 'user', at: askedAt }, { role: 'user', at: new Date(now).toISOString(), pending: true }] }, now).text, 'Claude is working… · 2h5m');
assert.equal(chatStatus({ working: true, items: [] }, now).text, 'Claude is working…');
console.log('ok chat status');

import { findClearedSuccessor, tmuxFor } from './server.mjs';
{
    const c = { from: 'old', cwd: '/r', clearedAt: 1_000 };
    const ss = [
        { id: 'old', cwd: '/r', created: 0 },
        { id: 'before', cwd: '/r', created: 900 },
        { id: 'other', cwd: '/x', created: 2_000 },
        { id: 'new', cwd: '/r', created: 1_500 },
        { id: 'newer', cwd: '/r', created: 1_800 },
        { id: 'late', cwd: '/r', created: 1_000 + 60_000 }
    ];
    assert.equal(findClearedSuccessor(ss, c).id, 'newer');
    assert.equal(findClearedSuccessor(ss.filter(s => !s.id.startsWith('new')), c), null);
    const aliases = new Map([['new-id-123', { tmux: 'cc-old-id-1', from: 'old-id-1234' }]]);
    assert.equal(tmuxFor('new-id-123', aliases), 'cc-old-id-1');
    assert.equal(tmuxFor('abcdef0123', aliases), 'cc-abcdef01');
}
console.log('ok clear');

import { pipelineOf, ciOf } from './server.mjs';
{
    const gl = { status: 'success', web_url: 'https://gl/p/1', finished_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:01:00Z' };
    assert.deepEqual(pipelineOf(gl), { status: 'success', url: 'https://gl/p/1', at: '2026-11-12T10:00:00Z' });
    assert.deepEqual(pipelineOf({ status: 'running', web_url: 'u', updated_at: 't' }), { status: 'running', url: 'u', at: 't' });
    assert.equal(pipelineOf(undefined), null); // MR without a pipeline
    assert.equal(pipelineOf(null, [], 'pr'), null); // PR without checks
    const ok = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-12T09:00:00Z' };
    const skip = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED', completedAt: '2026-11-12T09:30:00Z' };
    const run = { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-12T09:10:00Z' };
    const ctxFail = { __typename: 'StatusContext', state: 'FAILURE', startedAt: '2026-11-12T08:00:00Z' };
    assert.deepEqual(pipelineOf(null, [ok, skip], 'https://gh/pull/1'), { status: 'success', url: 'https://gh/pull/1/checks', at: '2026-11-12T09:30:00Z' });
    assert.equal(pipelineOf(null, [ok, run], 'p').status, 'running');
    assert.equal(pipelineOf(null, [ok, run, ctxFail], 'p').status, 'failed');
    assert.equal(pipelineOf(null, [{ __typename: 'StatusContext', state: 'PENDING' }], 'p').status, 'running');
    assert.equal(ciOf({ status: 'failed' }), 'failing');
    assert.equal(ciOf({ status: 'pending' }), 'running');
    assert.equal(ciOf({ status: 'success' }), null);
    assert.equal(ciOf(null), null);
}
console.log('ok pipeline');

import { clearState } from './public/chat.js';
assert.deepEqual(clearState(null), { at: 0, fresh: false });
assert.deepEqual(clearState(''), { at: 0, fresh: false }); // "Show" resets the key to ''
assert.deepEqual(clearState('1700000000000'), { at: 1700000000000, fresh: false }); // Clear view, old format
assert.deepEqual(clearState('{"at":1700000000000,"mode":"new"}'), { at: 1700000000000, fresh: true }); // New conversation
assert.deepEqual(clearState('junk'), { at: 0, fresh: false });
console.log('ok clear state');

import { folderFor, editorsFrom, openInEditor } from './server.mjs';
{
    const on = new Set(['/wt', '/repo']), exists = p => on.has(p);
    assert.equal(folderFor('/wt', '/repo', exists), '/wt'); // worktree wins
    assert.equal(folderFor('/gone', '/repo', exists), '/repo'); // worktree removed -> repo
    assert.equal(folderFor(null, '/repo', exists), '/repo');
    assert.equal(folderFor('/gone', '/also-gone', exists), null); // nothing to open
    assert.equal(folderFor('-a', 'rel', () => true), null); // never a flag or a relative path

    assert.deepEqual(editorsFrom(['/Applications/Safari.app', '/Applications/IntelliJ IDEA Ultimate.app'], {}),
        [{ id: 'idea', name: 'IntelliJ IDEA', cmd: ['open', ['-a', '/Applications/IntelliJ IDEA Ultimate.app']] }]);
    assert.deepEqual(editorsFrom(['/Applications/Visual Studio Code.app'], { idea: '/bin/idea' }).map(e => [e.id, e.cmd]),
        [['idea', ['/bin/idea', []]], ['vscode', ['open', ['-a', '/Applications/Visual Studio Code.app']]]]);
    assert.deepEqual(editorsFrom([], { code: '/usr/local/bin/code' }).map(e => e.id), ['vscode']);
    assert.deepEqual(editorsFrom([], {}), []);

    const calls = [], exec = async (...a) => { calls.push(a); };
    const opts = { exec, eds: async () => editorsFrom(['/A/IntelliJ IDEA.app'], {}), list: async () => [{ items: [{ key: 'k', folder: '/wt' }, { key: 'gone', folder: null }] }] };
    await openInEditor('k', 'idea', opts);
    assert.deepEqual(calls, [['open', ['-a', '/A/IntelliJ IDEA.app', '/wt']]]);
    await assert.rejects(openInEditor('k', 'vscode', opts), { status: 400 });
    await assert.rejects(openInEditor('gone', 'idea', opts), { status: 404, message: 'folder is gone' });
    await assert.rejects(openInEditor('nope', 'idea', opts), { status: 404, message: 'unknown item' });
    assert.equal(calls.length, 1);
}
console.log('ok open in editor');
