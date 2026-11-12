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
// ponytail: attentionEvents lives in index.html's inline script, so it's lifted out by text
import { readFileSync } from 'node:fs';
const page = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const attentionEvents = new Function(`${page.match(/^ {2}function attentionEvents[\s\S]*?^ {2}}$/m)[0]}\nreturn attentionEvents;`)();
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
