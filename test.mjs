import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
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
// pracsys !1791: meta.finished flipped while the gate agent waited on its own background Cucumber run
const bg = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Command running in background with ID: b172vb7y2. Output is being written to: /tmp/tasks/b172vb7y2.output.' }] } };
const child = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'v', content: [{ type: 'text', text: 'Async agent launched successfully. (internal metadata)\nagentId: a2da1ee3a8630e53c (internal ID)' }] }] } };
const told = id => ({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>` } });
const onHold = say => ({ type: 'assistant', message: { content: [{ type: 'text', text: say }] } });
assert.equal(st([call('a'), bg, onHold('Waiting on Cucumber.')], 3 * MIN, { finished: true }).status, 'running');
assert.equal(st([call('a'), bg, onHold('Waiting on Cucumber.')], 31 * MIN, { finished: true }).status, 'done');
assert.equal(st([call('a'), bg, onHold('Waiting on Cucumber.')], 3 * MIN).status, 'running'); // not stopped after 2 min idle
assert.equal(st([call('a'), bg, call('v'), child, told('b172vb7y2'), onHold('Waiting on the validator.')], 3 * MIN, { finished: true }).status, 'running');
assert.equal(st([call('a'), bg, call('v'), child, told('b172vb7y2'), told('a2da1ee3a8630e53c'), ended], 3 * MIN, { finished: true }).status, 'done');
console.log('ok agents');

import { splitTldr, splitTopic, toolSummary, chatItems, pendingQuestion, sendSteps } from './server.mjs';
assert.deepEqual(splitTldr('Long text.\n\n**TLDR:** It works.'), { tldr: 'It works.', text: 'Long text.' });
assert.equal(splitTldr('a\n**TLDR**: fixed **now**').tldr, 'fixed **now**');
assert.equal(splitTldr('**TL;DR: shipped**').tldr, 'shipped');
assert.equal(splitTldr('we use tldraw here').tldr, null);
assert.deepEqual(splitTopic('**▸ Chat topic headers**\n\nBody.\n\n**TLDR:** done'), { topic: 'Chat topic headers', needsYou: false, text: 'Body.\n\n**TLDR:** done' });
assert.deepEqual(splitTopic('\n  ▸ Plain topic\nBody'), { topic: 'Plain topic', needsYou: false, text: 'Body' });
for (const line of ['**▸ Pick a port · needs you**', '**▸ Pick a port · Needs You**', '**▸ Pick a port - needs you**', '**▸ Pick a port (needs you)**', '**▸ Pick a port · needs you:**']) {
    assert.deepEqual(splitTopic(`${line}\nBody`), { topic: 'Pick a port', needsYou: true, text: 'Body' }, line);
}
assert.equal(splitTopic('**▸ What needs you to know**\nx').needsYou, false);
assert.equal(splitTopic('**▸ Colon topic:**\nx').topic, 'Colon topic');
assert.equal(splitTopic('**▸ Colon outside**:\nx').topic, 'Colon outside');
assert.deepEqual(splitTopic('Body first\n**▸ Not a topic**'), { topic: null, needsYou: false, text: 'Body first\n**▸ Not a topic**' });
assert.deepEqual(splitTopic('**▸ Only topic**'), { topic: 'Only topic', needsYou: false, text: '' });
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
const topical = chatItems([{ type: 'user', message: { content: 'go' } }, say('**▸ Topic headers**\n\nDone.\n\n**TLDR:** shipped')]).at(-1);
assert.deepEqual([topical.topic, topical.text, topical.tldr, topical.needsYou], ['Topic headers', 'Done.', 'shipped', false]);
// needs-you: the topic marker, or (no marker) a TLDR ending in "?"
const needy = text => chatItems([{ type: 'user', message: { content: 'go' } }, say(text)]).at(-1);
assert.deepEqual([needy('**▸ Ports · needs you**\n\nX.\n\n**TLDR:** pick one').topic, needy('**▸ Ports · needs you**\n\nX.\n\n**TLDR:** pick one').needsYou], ['Ports', true]);
assert.equal(needy('**▸ Ports**\n\nX.\n\n**TLDR:** **Use 4478?**').needsYou, true);
assert.equal(needy('Is it? Yes.\n\nTLDR: done').needsYou, false);
// Two replies with only an agent message / task notification between them stay separate bubbles, each with its own TLDR.
const twoTurns = chatItems([
    { type: 'user', message: { content: 'security issues?' } },
    say('The main risk: X.\n\n**TLDR:** **A website can drive it.**'),
    { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>…' },
    { type: 'user', isMeta: true, message: { content: 'Another Claude session sent a message: <agent-message from="a1">done</agent-message>' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } },
    say('Design B is in.\n\n**TLDR:** **Design B is done.**'),
    { type: 'user', message: { content: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' } },
    say('Design A is in.\n\nTLDR: Design A is done.')
]);
assert.deepEqual(twoTurns.map(i => [i.role, i.tldr]), [
    ['user', undefined], ['assistant', '**A website can drive it.**'], ['assistant', '**Design B is done.**'], ['assistant', 'Design A is done.']
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
assert.equal(nextStep(open({ draft: true }), null), 'Draft — mark it ready for review');
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
// tracker "Build faction perks simulator": done without an MR stays visible for 2 h as "finished", then drops
const perks = now => workItems([{ id: 'm', project: 'tracker', prs: [], agents: [agent('perks', 0, { description: 'Build faction perks simulator' })] }], () => null, now);
assert.deepEqual(perks(3600_000).map(i => [i.key, i.column, i.next]), [['perks', 'finished', 'Finished without an MR']]);
assert.deepEqual(perks(3 * 3600_000), []);
const one = prOf => workItems([{ id: 's', project: 'p', prs: [{ url: mr(5), at: 1 }], agents: [] }], prOf, 0, new Map())[0];
assert.equal(one(() => open({ ready: true })).stageLabel, 'Approved');
assert.deepEqual((({ column, stageLabel, next }) => [column, stageLabel, next])(one(() => ({ state: 'closed' }))), ['done', 'Closed', 'Closed without merging']);
const verifying = workItems([{ id: 's', project: 'p', prs: [], agents: [agent('v', 1, { status: 'running', stage: 2 })] }], () => null, 0, new Map());
assert.deepEqual(verifying.map(i => i.stageLabel), ['Verify']);
// forge-seeded MRs: deduped against transcript URLs, bound to the project's newest session, others' projects untouched
const forged = workItems([
    { id: 'old', project: 'p', updated: 1, prs: [{ url: mr(1), at: 5 }], agents: [] },
    { id: 'new', project: 'p', updated: 9, prs: [], agents: [] },
    { id: 'q', project: 'q', updated: 99, prs: [], agents: [] }
], () => open(), 0, new Map(), [{ url: mr(1), project: 'p' }, { url: mr(7), project: 'p' }, { url: mr(7), project: 'p' }]);
assert.deepEqual(forged.map(i => [i.key, i.sessionId, i.column]), [[mr(1), 'old', 'review'], [mr(7), 'new', 'review']]);
console.log('ok items');

import { loadStore, record, seeds, flush } from './server/store.mjs';
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-store-'));
    const file = join(dir, 'items.json');
    const DAY = 864e5;
    const item = (url, prState, extra) => ({ pr: url, project: 'p', title: 't', sessionId: 's1', branch: 'b', prState, agentLinks: [{ id: 'a1', description: 'Impl !1', finished: 5 }], ...extra });

    // round trip: written once (mode 0600, no temp left), read back, throttled, and lastSeen alone is no change
    const st = loadStore(file);
    record(st, [item(mr(1), { state: 'open', title: 'One', issue: '9' }), item(mr(2), { state: 'merged' })], 1000);
    flush(st, 20_000);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['items.json']);
    const back = loadStore(file);
    assert.deepEqual(back.data.p[mr(1)], { title: 'One', issue: '9', branch: 'b', sessionId: 's1', firstSeen: 1000, lastSeen: 1000, state: 'open', mergedAt: null, agents: [{ id: 'a1', description: 'Impl !1', finished: 5 }] });
    assert.equal(back.data.p[mr(2)].mergedAt, 1000);
    record(back, [item(mr(1), { state: 'open', title: 'One', issue: '9' })], 2000);
    assert.equal(back.dirty, false);
    record(back, [item(mr(1), { state: 'merged' })], 3000);
    assert.equal(back.dirty, true);
    flush(back, 25_000); // within 10 s of nothing written yet by this store: writes
    back.dirty = true;
    const before = readFileSync(file, 'utf8');
    record(back, [item(mr(1), { state: 'merged' }, { branch: 'other' })], 26_000);
    flush(back, 26_000 + 5000);
    assert.equal(readFileSync(file, 'utf8'), before, 'throttled to one write per 10 s');

    // seeding: open ones, and merged ones only within the window
    assert.deepEqual(seeds(loadStore(file), 4000, 3 * DAY).map(s => [s.url, s.sessionId, s.agents.length]).sort(), [[mr(1), 's1', 1], [mr(2), 's1', 1]]);
    assert.deepEqual(seeds(loadStore(file), 4000 + 4 * DAY, 3 * DAY), []);

    // pruning: merged/closed entries unseen for 30 days go, open ones stay
    const old = loadStore(file);
    record(old, [item(mr(3), { state: 'open' })], 1000);
    record(old, [], 1000 + 31 * DAY);
    assert.deepEqual(Object.keys(old.data.p), [mr(3)]);

    // corrupt file: starts empty and keeps a .bak
    writeFileSync(file, '{"p": ');
    const bad = loadStore(file);
    assert.deepEqual(bad.data, {});
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"p": ');
    rmSync(dir, { recursive: true });

    // a stored MR no transcript mentions any more still seeds its row, with its finished agent and its session
    const kept = workItems([{ id: 's1', project: 'p', updated: 1, prs: [], agents: [] }, { id: 's2', project: 'p', updated: 9, prs: [], agents: [] }], () => open(), 0, new Map(),
        [{ url: mr(8), project: 'p', sessionId: 's1', agents: [{ id: 'gone', description: 'Impl !8', finished: 7 }] }]);
    assert.deepEqual(kept.map(i => [i.key, i.sessionId, i.agentStatus, i.updated]), [[mr(8), 's1', 'done', 7]]);
}
console.log('ok store');

import { tmuxArgs } from './server.mjs';
assert.deepEqual(tmuxArgs(['send-keys', '-t', 'cc-1', 'Escape'], undefined), ['send-keys', '-t', 'cc-1', 'Escape']);
assert.deepEqual(tmuxArgs(['has-session'], 'hbtest'), ['-L', 'hbtest', 'has-session']);
console.log('ok tmux socket');

import { repoName } from './server.mjs';
assert.equal(repoName('github-personal:lommerusk113/homebase.git\n'), 'homebase');
assert.equal(repoName('git@gitlab.com:tritt/accounting/pracsys.git'), 'pracsys');
assert.equal(repoName('https://github.com/contaas/portal-frontend'), 'portal-frontend');
console.log('ok repo name');
import { rowAction } from './server.mjs';
const act = (prState, agent, url = mr(4)) => rowAction(url, prState, agent, 'T');
assert.deepEqual(act(open({ ready: true, reviewers: ['Ann'] }), null), { label: 'Merge + close issue', message: `Run review-gate on !4 (${mr(4)}). If the verdict is ready, merge it and close its issue. If it's fix first, show me the findings and don't merge.` });
assert.equal(act(open({ ready: true }), null, 'https://github.com/o/r/pull/9').message.slice(0, 63), 'Run review-gate on #9 (https://github.com/o/r/pull/9). If the v');
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

import { gateRuns, gateFor, toGate } from './server.mjs';
// shapes as in real transcripts: Skill tool_use { skill, args }, the skill's report as later assistant text
const said = (ts, ...content) => ({ type: 'assistant', timestamp: ts, message: { content } });
const skill = (name, args) => ({ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: name, args } });
const txt = text => ({ type: 'text', text });
const gateTail = [
    said('2026-11-13T10:00:00Z', txt('**ready** to go, I think')), // before any gate: ignored
    said('2026-11-13T10:01:00Z', skill('review-gate', `!4 ${mr(4)}`)),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'Launching skill: review-gate' }] } },
    said('2026-11-13T10:02:00Z', txt('Running code-review and threat-review as subagents.')),
    said('2026-11-13T10:09:00Z', txt('**Verdict: fix first** — adds the gate badge\n\n| # | Sev |\n\n**TLDR:** **Fix first**: one HIGH on !4, fix the null check.')),
    said('2026-11-13T11:00:00Z', skill('review-gate', 'branch kjn-gate at commit abc1234')),
    said('2026-11-13T11:05:00Z', txt('Verdict: **ready** — clean.\nTLDR: **ready**, open it.'))
];
const runs = gateRuns(gateTail);
assert.deepEqual(runs.map(r => [r.verdict, r.at, r.tldr, r.commit]), [
    ['fix first', Date.parse('2026-11-13T10:09:00Z'), '**Fix first**: one HIGH on !4, fix the null check.', null],
    ['ready', Date.parse('2026-11-13T11:05:00Z'), '**ready**, open it.', 'abc1234']
]);
assert.deepEqual(gateRuns([said('t', skill('code-review', '!4')), said('t', txt('**Verdict: ready**'))]), []); // other skills don't arm
// a subagent briefed with review-gate reports through its handback
const handback = said('2026-11-13T12:00:00Z', { type: 'tool_use', name: 'SubagentHandback', input: { message: '**Verdict: ready** — fine\n\n**TLDR:** **ready** for review, open !7.' } });
assert.equal(gateRuns([handback], 'Run review-gate on the branch').at(0).verdict, 'ready');
assert.deepEqual(gateRuns([handback], 'Implement the badge'), []);
// association: URL, !N (not !40 or a path), branch
assert.equal(gateFor(runs, mr(4), 'x'), runs[0]);
assert.equal(gateFor(runs, mr(9), 'kjn-gate'), runs[1]);
assert.equal(gateFor(runs, mr(40), 'other'), null);
assert.equal(gateFor([{ text: 'see #9', at: 1 }], 'https://github.com/o/r/pull/9', null).at, 1);
// staleness: commit from the report, else the head first seen with the run
assert.equal(toGate(runs[1], 'abc1234ffff').stale, false);
assert.equal(toGate(runs[1], 'def5678ffff').stale, true);
const heads = new Map();
assert.equal(toGate(runs[0], 'aaa111', heads).stale, false);
assert.deepEqual(toGate(runs[0], 'bbb222', heads), { verdict: 'fix first', at: runs[0].at, tldr: runs[0].tldr, commit: null, stale: true });
assert.equal(toGate(null, 'x'), null);
const gated = workItems([{ id: 's', project: 'p', prs: [{ url: mr(4), at: 1 }], gates: runs, agents: [] }], () => open({ ready: true, sha: 'abc' }), 0, new Map());
assert.equal(gated[0].gate.verdict, 'fix first');
console.log('ok review gate');
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
assert.deepEqual(ev([it('a', 'doing')], [it('a', 'finished')]), [['finished', 'a']]);
assert.deepEqual(ev([it('a', 'review')], []), []);
assert.deepEqual(ev([it('a', 'review')], [it('a', 'review', 'failing')]), [['failing', 'a']]);
assert.deepEqual(ev([it('a', 'review', 'failing')], [it('a', 'review', 'failing')]), []);
assert.deepEqual(ev([], [it('n', 'needs-you'), it('m', 'review')]), [['needs-you', 'n']]);
// comment events: newer than seen and than the previous poll's newest; none before comments were loaded
const cm = (key, ...ats) => ({ key, pr: `u/${key}`, column: 'review', comments: { latestAt: ats[0] ?? null, count: ats.length, items: ats.map((at, i) => ({ id: i, author: 'Børre Stellander', at })) } });
const CT = t => `2026-11-13T10:0${t}:00Z`, S = t => Date.parse(CT(t));
const cev = (prev, next, seen) => attentionEvents(prev, next, () => seen).map(e => [e.kind, e.item.key, e.comments?.length]);
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(2), CT(1))], S(0)), [['comment', 'a', 1]]);
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(1))], S(0)), []); // nothing newer than last poll
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(2), CT(1))], S(3)), []); // already seen
assert.deepEqual(cev([{ key: 'a', pr: 'u/a', column: 'review' }], [cm('a', CT(2))], S(0)), []); // comments just loaded
assert.deepEqual(cev([cm('a')], [cm('a', CT(2))], S(0)), [['comment', 'a', 1]]); // first comment on the MR
assert.deepEqual(ev([it('a', 'review')], [it('a', 'needs-you')]), [['needs-you', 'a']]); // default seen keeps old calls working
console.log('ok attention');
import { freshComments, authorSummary } from './public/core.js';
import { isBot, humanComments } from './server.mjs';
const c3 = { items: [{ at: CT(3), author: 'Børre Stellander' }, { at: CT(2), author: 'Ann Lee' }, { at: CT(1), author: 'Børre Stellander' }] };
assert.deepEqual(freshComments(c3, S(1)).map(c => c.at), [CT(3), CT(2)]);
assert.deepEqual(freshComments(null, 0), []);
assert.equal(authorSummary(c3.items), 'Børre, Ann');
assert.equal(authorSummary([...c3.items, { author: 'Kim X' }]), 'Børre, Ann +1');
assert.equal(isBot({ username: 'dependabot[bot]' }), true);
assert.equal(isBot({ username: 'project_123_bot_ab12' }), true);
assert.equal(isBot({ username: 'renovate-bot' }), true);
assert.equal(isBot({ username: 'x', type: 'Bot' }), true);
assert.equal(isBot({ username: 'borre.stellander' }), false);
assert.equal(isBot({ username: 'abbott' }), false);
const raw = [
    { id: 1, author: { name: 'Joakim', username: 'me' }, at: CT(5), body: 'mine', url: 'u#1' },
    { id: 2, author: { name: 'Bot', username: 'gitlab-bot' }, at: CT(4), body: 'beep', url: 'u#2' },
    { id: 3, author: { name: 'Børre Stellander', username: 'borre' }, at: CT(1), body: '**Old** note', url: 'u#3', resolved: false },
    { id: 4, author: { name: 'Børre Stellander', username: 'borre' }, at: CT(3), body: 'x'.repeat(200), url: 'u#4', resolved: null },
    { id: 5, author: { name: 'Ann', username: 'ann' }, at: CT(2), body: '  ', url: 'u#5' }
];
const hc = humanComments(raw, 'me');
assert.deepEqual(hc.items.map(c => c.id), [4, 3]); // self, bot and empty dropped; newest first
assert.equal(hc.latestAt, CT(3));
assert.equal(hc.count, 2);
assert.equal(hc.items[1].excerpt, 'Old note');
assert.equal(hc.items[1].resolved, false);
assert.equal('resolved' in hc.items[0], false);
assert.equal(hc.unresolved, 1);
assert.deepEqual(hc.unresolvedBy, ['Børre Stellander']);
// unresolved human threads on an open MR: needs-you, it's on me, ahead of CI like requested changes
import { withThreads, itemColumn } from './server.mjs';
const waiting = open({ reviewers: ['Børre Stellander'] });
const thr = (n, by = ['Børre Stellander']) => ({ count: n + 1, items: [], unresolved: n, unresolvedBy: n ? by : [] });
const t2 = withThreads({ ...waiting, ci: 'failing' }, thr(2));
assert.equal(itemColumn(t2, null, true), 'needs-you');
assert.equal(nextStep(t2, null), 'Address 2 unresolved comments from Børre Stellander');
assert.equal(nextStep(withThreads(waiting, thr(1, ['A', 'B'])), null), 'Address 1 unresolved comment from A, B');
assert.equal(rowAction(mr(4), t2, null, 'T').label, 'Fix & reply');
assert.equal(itemColumn(withThreads(waiting, thr(0)), null, true), 'review'); // all resolved, no approval yet
assert.equal(nextStep(withThreads(waiting, thr(0)), null), 'Waiting for review by Børre Stellander');
assert.equal(withThreads(waiting, null), waiting); // no comments data yet
// a stopped agent needs you even when its MR is ready; a finished one without an MR is "finished"
assert.equal(itemColumn(open({ ready: true }), { status: 'stopped' }, true), 'needs-you');
assert.equal(itemColumn(null, { status: 'stopped' }, false), 'needs-you');
assert.equal(itemColumn(null, { status: 'done' }, false), 'finished');
assert.equal(withThreads({ state: 'merged' }, thr(2)).changes, undefined);
// the comment that moves an item into needs-you notifies once
const nc = { ...cm('a', CT(2)), column: 'needs-you' };
assert.deepEqual(cev([cm('a', CT(1))], [nc], S(0)), [['comment', 'a', 1]]);
assert.ok(hc.items[0].excerpt.length <= 141);
assert.equal(humanComments(raw, 'me', 1).items.length, 1);
assert.deepEqual(humanComments([], 'me'), { latestAt: null, count: 0, items: [], unanswered: 0, unansweredBy: [], unresolved: 0, unresolvedBy: [], replied: 0, repliedTo: [] });
// whose turn per GitLab thread: the last human note decides; replied threads wait on the reviewer
const B = { name: 'Børre', username: 'borre' }, ME = { name: 'Joakim', username: 'me' }, BOT = { name: 'Bot', username: 'gitlab-bot' };
const th = (...authors) => ({ resolved: false, notes: authors.map(author => ({ author })) });
const turn = (...threads) => humanComments([], 'me', 10, threads);
const mine = turn(th(B, ME), th(B, ME, BOT)); // last note by me (my Claude posts as me), a bot after me doesn't count
assert.deepEqual([mine.unresolved, mine.replied, mine.repliedTo], [0, 2, ['Børre']]);
const wr = withThreads({ ...waiting, changes: true }, mine); // GitLab's discussions_not_resolved set changes
assert.equal(itemColumn(wr, null, true), 'review');
assert.equal(nextStep(wr, null), 'Replied to 2 threads — waiting for Børre to resolve');
assert.equal(rowAction(mr(4), wr, null, 'T'), null);
assert.equal(rowAction(mr(4), { ...wr, reviewers: [] }, null, 'T'), null); // no Request review either
assert.equal(rowAction(mr(4), { ...wr, ci: 'failing' }, null, 'T').label, 'Fix pipeline'); // only a failing pipeline beats it
assert.equal(nextStep({ ...wr, ci: 'running' }, null), 'Replied to 2 threads — waiting for Børre to resolve');
// mergeable wins over replied threads; unanswered comments and a failing pipeline still win over mergeable
const wrReady = { ...wr, ready: true };
assert.equal(itemColumn(wrReady, null, true), 'ready');
assert.equal(nextStep(wrReady, null), 'Approved — merge it · 2 replied threads still open');
assert.equal(rowAction(mr(4), wrReady, null, 'T').label, 'Merge + close issue');
assert.equal(nextStep({ ...wrReady, replied: 1 }, null), 'Approved — merge it · 1 replied thread still open');
assert.equal(rowAction(mr(4), { ...wrReady, ci: 'failing' }, null, 'T').label, 'Fix pipeline');
const theirsReady = withThreads({ ...waiting, ready: true }, turn(th(B), th(ME, B)));
assert.equal(nextStep(theirsReady, null), 'Approved — 2 unanswered comments from Børre');
assert.equal(rowAction(mr(4), theirsReady, null, 'T').label, 'Fix & reply');
const theirs = turn(th(B), th(ME, B));
assert.deepEqual([theirs.unresolved, theirs.unresolvedBy, theirs.replied], [2, ['Børre'], 0]);
assert.equal(itemColumn(withThreads(waiting, theirs), null, true), 'needs-you');
const mix = withThreads(waiting, turn(th(B), th(B, ME)));
assert.equal(itemColumn(mix, null, true), 'needs-you');
assert.equal(nextStep(mix, null), 'Address 1 unresolved comment from Børre');
assert.equal(rowAction(mr(4), mix, null, 'T').label, 'Fix & reply');
const done = turn({ ...th(B), resolved: true }, th(ME), th(BOT)); // resolved, my own, bot-only threads don't count
assert.deepEqual([done.unresolved, done.replied], [0, 0]);
assert.equal(withThreads(waiting, done), waiting);
// a non-resolvable general comment is a new comment, not a thread
const gen = humanComments([{ id: 9, author: B, at: CT(1), body: 'LGTM', url: 'u#9', resolved: null }], 'me', 10, []);
assert.deepEqual([gen.count, gen.unresolved, gen.replied, gen.unanswered], [1, 0, 0, 0]);
// general comments by others after my newest note (thread or general) are on me
const note = (author, s, general = true) => ({ id: s, author, at: CT(s), body: 'x', url: `u#${s}`, resolved: general ? null : false, general });
const ANN = { name: 'Ann', username: 'ann' };
const asked = humanComments([note(ME, 1), note(B, 2)], 'me', 10, []);
assert.deepEqual([asked.unanswered, asked.unansweredBy], [1, ['Børre']]);
const askedPr = withThreads(waiting, asked);
assert.equal(itemColumn(askedPr, null, true), 'needs-you');
assert.equal(nextStep(askedPr, null), "Reply to Børre's comment");
assert.deepEqual(rowAction(mr(4), askedPr, null, 'T'), { label: 'Fix & reply', message: `Address the review comments on !4 (${mr(4)}), push, and reply in each thread.` });
assert.equal(withThreads(waiting, humanComments([note(B, 2), note(ME, 3, false)], 'me', 10, [])), waiting); // my later thread note answers it
assert.equal(withThreads(waiting, humanComments([note(ME, 1), note(BOT, 2)], 'me', 10, [])), waiting); // bots don't count
assert.equal(nextStep(withThreads(waiting, humanComments([note(ME, 1), note(B, 2), note(ANN, 3)], 'me')), null), 'Answer 2 comments from Ann, Børre');
const both = withThreads(waiting, humanComments([note(B, 2)], 'me', 10, [th(B), th(ANN)]));
assert.deepEqual([both.unresolved, both.unanswered], [2, 1]);
assert.equal(nextStep(both, null), 'Address 2 unresolved threads and answer 1 comment from Børre, Ann');
const askedReady = withThreads({ ...waiting, ready: true }, asked);
assert.equal(nextStep(askedReady, null), 'Approved — 1 unanswered comment from Børre');
assert.equal(rowAction(mr(4), askedReady, null, 'T').label, 'Fix & reply');
assert.equal(withThreads(waiting, humanComments([], 'me', 10, [])), waiting); // no comments
console.log('ok comments');
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
const you = (text, at) => ({ type: 'user', message: { content: text }, timestamp: at });
const tagged = chatItems([say('Fix A or B?'), you('Do both', 't1')]); // chip answer
assert.deepEqual(tagged.map(i => [i.role, i.answer, i.replies]), [['assistant', { text: 'Do both', at: 't1' }, undefined]]);
assert.deepEqual(chatItems([say('Ship it?'), you('yes')]).map(i => [i.role, i.answer?.text]), [['assistant', 'yes']]); // typed
assert.deepEqual(chatItems([say('Ship it?'), you('Go ahead!')])[0].answer.text, 'Go ahead!');
assert.deepEqual(chatItems([say('Ship it?'), you('yes, but also do X')]).map(i => [i.role, i.answer]), [['assistant', undefined], ['user', undefined]]);
assert.deepEqual(chatItems([say('Done.'), you('yes')]).map(i => i.role), ['assistant', 'user']); // not after a question
assert.deepEqual(chatItems([you('yes')]).map(i => i.role), ['user']);
// an answer to an older question: Claude said more after asking, so "yes" is a bubble
assert.deepEqual(chatItems([say('Ship it?'), tu('Bash'), say('Also cleaned up.'), you('yes')]).map(i => [i.role, i.answer]),
    [['assistant', undefined], ['tools', undefined], ['assistant', undefined], ['user', undefined]]);
assert.deepEqual(chatItems([say('Ship it?'), you('yes'), you('no')]).map(i => i.role), ['assistant', 'user']); // one answer per question
assert.deepEqual(chatItems([say('Ship it?'), { type: 'queue-operation', operation: 'enqueue', content: 'Yes', timestamp: 't2' }])[0].answer, { text: 'Yes', at: 't2', queued: true });
const ask2 = tu('AskUserQuestion', { id: 'q2', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite' }] }] } });
assert.deepEqual(pendingAsk([ask2]), [{ question: 'Which DB?', options: ['Postgres', 'SQLite'] }]);
assert.equal(pendingAsk([ask2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] } }]), null);
assert.equal(pendingQuestion([tu('AskUserQuestion', { id: 'q3', input: {} })]), 'Claude asked a question.');
console.log('ok quick replies');

import { addUsage, readUsage, formatDuration, formatTokens, limitsOf } from './server.mjs';
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
// an interrupt after the second chunk of a reply flags the merged bubble; a tool result between chunks doesn't split it
const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } };
assert.deepEqual(chatItems([say('A.'), toolResult, say('B.'), { type: 'user', message: { content: '[Request interrupted by user]' } }]).map(i => [i.role, i.text, i.interrupted]), [
    ['assistant', 'A.\n\nB.', true]
]);
// a subagent's queue operations aren't the user's pending prompts
assert.deepEqual(chatItems([{ type: 'queue-operation', operation: 'enqueue', content: 'side work', isSidechain: true, timestamp: 't1' }]), []);
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

import { repoPath, groupIssues, milestoneOf, activeMilestones, keepMilestone, worksOn, noMilestones } from './server.mjs';
import { inMilestone, toData, isLoading, emptyPill } from './public/milestone.js';
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

// A project without milestones to show gets a final answer, never loading: true.
{
    const gl = { host: 'gitlab.com', path: 'g/p' }, gh = { host: 'github.com', path: 'o/r' };
    const none = noMilestones('p', gl, 'none');
    assert.deepEqual([none.milestones, none.selected, none.loading, none.updating, none.reason, none.url], [[], null, false, false, 'none', 'https://gitlab.com/g/p/-/milestones']);
    const err = noMilestones('r', gh, 'error', 'gh: Not Found (HTTP 404)');
    assert.deepEqual([err.reason, err.error, err.loading, err.url], ['error', 'gh: Not Found (HTTP 404)', false, 'https://github.com/o/r/milestones']);
    assert.equal(noMilestones('x', null, 'unsupported', 'unknown project').url, null);

    // client: any answer maps to data; one without a milestone list is the error state
    assert.deepEqual(toData(200, JSON.stringify(none)), none);
    const bare = toData(500, 'Command failed: gh api …\n');
    assert.deepEqual([bare.reason, bare.error, bare.milestones, bare.selected], ['error', 'Command failed: gh api …', [], null]);
    assert.equal(toData(502, '').error, 'HTTP 502');
    assert.equal(toData(500, '', 'p').project, 'p'); // the Issues tab names the project in the error
    // fast polling stops on a final state, even while a refresh of the list runs in the background
    assert.equal(isLoading({ ...err, updating: true }), false);
    assert.equal(isLoading({ reason: null, selected: { loading: true }, updating: false }), true);
    assert.equal(isLoading({ reason: null, selected: { groups: {} }, updating: false }), false);
    assert.deepEqual(emptyPill(none), { text: 'No milestones', tip: 'No open milestones in p', err: false });
    assert.deepEqual(emptyPill(err), { text: 'Milestones unavailable', tip: 'gh: Not Found (HTTP 404)\nRefresh (r) to retry', err: true });
    assert.equal(emptyPill({ reason: null }), null);
    assert.equal(emptyText(none), 'No open milestones in p.');
    assert.match(emptyText(err), /^Milestones unavailable for r: gh: Not Found \(HTTP 404\)\. Press r/);
    assert.equal(emptyText(noMilestones('x', null, 'unsupported', 'unknown project')), "Milestones aren't available for x: unknown project.");
}
console.log('ok milestones');

import { excerpt } from './server.mjs';
import { pillLabel } from './public/milestone.js';
import { issueCards, buildLanes, closedBy, chatMessage, shortTitle, owners, emptyText } from './public/issues.js';
assert.equal(excerpt('## Problem\n\nThe **row** only shows after a [reload](http://x).\n\n```js\ncode()\n```\nDone.'), 'The row only shows after a reload. Done.');
assert.equal(excerpt('word '.repeat(100), 20), 'word word word word…');
assert.equal(excerpt(null), '');
const P = (name, username) => ({ name, username });
const me = P('Joakim Landsverk', 'jo'), bo = P('Børre Gaup', 'bo'), ann = P('Ann Ek', 'ann');
const isu = (iid, assignees = [], mrs = []) => ({ iid, title: `Supplier automation: I${iid}`, assignees, mrs });
const groups = {
    doing: [isu(1, [me], [{ iid: 11, state: 'open', author: me }]), isu(2, [], [{ iid: 12, state: 'open', author: bo }])],
    closable: [isu(3, [ann], [{ iid: 13, state: 'merged', author: ann }])],
    assigned: [isu(4, [bo, me])], unassigned: [isu(5), isu(6)],
    done: [isu(7, [me]), isu(8, [bo]), isu(9), isu(10, [P('Zed Old', 'zed')])]
};
const cards = issueCards(groups);
assert.deepEqual(cards.map(c => [c.iid, c.st]), [[1, 'doing'], [2, 'doing'], [3, 'closable'], [4, 'todo'], [5, 'free'], [6, 'free']]);
assert.deepEqual(owners(cards[1]), [bo]); // in progress, nobody assigned: the MR's author
const lanes = buildLanes(cards, groups.done, me);
// you first, then by name, then Unassigned; a closed-only person gets no lane
assert.deepEqual(lanes.map(l => [l.who?.username ?? null, l.me, l.list.map(c => c.iid), l.closed]),
    [['jo', true, [1, 4], 1], ['ann', false, [3], 0], ['bo', false, [2, 4], 1], [null, false, [5, 6], 1]]);
assert.deepEqual(buildLanes([], [], null).map(l => l.who), [null]); // Unassigned is always there
assert.deepEqual(closedBy(groups.done), [['Børre Gaup', 1], ['Joakim Landsverk', 1], ['Zed Old', 1], ['unassigned', 1]]);
assert.equal(chatMessage(cards[3]), 'Implement #4');
assert.equal(chatMessage(cards[0]), 'Check on #1 and !11');
assert.equal(chatMessage({ iid: 5, mrs: [{ iid: 20, state: 'merged' }, { iid: 21, state: 'open' }] }), 'Check on #5 and !21');
assert.equal(shortTitle('Supplier automation v2: undo misses pastes', 'Supplier automation'), 'undo misses pastes');
assert.equal(shortTitle('Fix: undo', 'Supplier automation'), 'Fix: undo');
const msel = { title: 'Supplier automation', total: 59, closed: 48, due: null, groups: { doing: [1, 2, 3], closable: [], assigned: [1, 2, 3], unassigned: [1, 2, 3, 4, 5] } };
assert.deepEqual(pillLabel({ title: 'Reports', total: 10, closed: 4, due: null, loading: true }), { text: '6 open', tip: 'Reports: loading issues… · no due date' });
assert.deepEqual(pillLabel(msel), { text: '11 open', tip: 'Supplier automation: 11 open of 59 (3 in progress, 3 not started, 5 unassigned), 48 closed · no due date' });
console.log('ok issues');

import { chatStatus } from './public/core.js';
assert.equal(chatStatus(null).kind, 'idle');
assert.equal(chatStatus({ error: true, working: true, asking: 'Pick one?' }).kind, 'error'); // a failed poll never reads as idle or stale working
assert.match(chatStatus({ error: true }).text, /reconnecting/);
assert.equal(chatStatus({ working: true, asking: 'Pick one?', items: [] }).kind, 'asking'); // asking wins
const askedAt = new Date(now - 125 * 60_000).toISOString();
assert.equal(chatStatus({ working: true, items: [{ role: 'user', at: askedAt }, { role: 'user', at: new Date(now).toISOString(), pending: true }] }, now).text, 'Claude is working… · 2h5m');
assert.equal(chatStatus({ working: true, items: [] }, now).text, 'Claude is working…');
assert.equal(chatStatus({ working: true, since: now - 2 * 60_000, items: [{ role: 'user', at: askedAt }] }, now).text, 'Claude is working… · 2m'); // turn start wins
console.log('ok chat status');

// Turn state, from real entry shapes (Claude Code 2.1.3xx).
import { turnState } from './server.mjs';
{
    const at = s => `2026-11-13T09:${s}.000Z`;
    const prompt = (uuid, s, origin = 'human', extra = {}) => ({ type: 'user', uuid, timestamp: at(s), origin: { kind: origin }, turnOrigin: origin, promptSource: 'typed', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'fix it' }, ...extra });
    const reply = (uuid, s, extra = {}) => ({ type: 'assistant', uuid, timestamp: at(s), message: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, ...extra });
    const tool = (uuid, s, name = 'Bash') => ({ type: 'assistant', uuid, timestamp: at(s), message: { content: [{ type: 'tool_use', id: `t-${uuid}`, name, input: {} }], stop_reason: 'tool_use' } });
    const td = s => ({ type: 'system', subtype: 'turn_duration', durationMs: 23240, timestamp: at(s), isMeta: false });
    const interrupt = (parentUuid, s) => ({ type: 'user', parentUuid, timestamp: at(s), interruptedMessageId: 'msg_1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    const queued = (s, mode = 'prompt') => ({ type: 'attachment', timestamp: at(s), attachment: { type: 'queued_command', commandMode: mode, prompt: 'also this' } });
    const hour = 3_600_000;
    const state = (entries, ageMs = 60_000) => turnState(entries, ageMs).state;

    // a normal turn: working until turn_duration, idle after; elapsed counts from the prompt
    const turn = [td('50:00'), prompt('p', '55:20'), tool('a', '55:30'), reply('b', '55:39')];
    assert.deepEqual(turnState(turn, 1_000), { state: 'working', since: Date.parse(at('55:20')) });
    assert.equal(state([...turn, td('55:43')], 1_000), 'idle');
    // a long thinking gap: no write for 5 minutes and no turn_duration yet is still working; 30+ minutes is stale
    assert.equal(state([td('40:00'), prompt('p', '50:00')], 5 * 60_000), 'working');
    assert.equal(state([td('40:00'), prompt('p', '50:00')], hour), 'idle');
    // Esc interrupt ends the turn without a turn_duration
    assert.equal(state([...turn, interrupt('b', '55:41')]), 'idle');
    // a prompt sent mid-turn interrupts it: the marker is parented on the new prompt, and the new turn goes on
    assert.equal(state([...turn, prompt('q', '55:45', 'human', { promptSource: 'queued' }), interrupt('q', '55:45')]), 'working');
    // an API error ends the turn (turn_duration follows, but the error alone is enough)
    assert.equal(state([...turn, reply('e', '55:41', { isApiErrorMessage: true })]), 'idle');
    // a turn retried after /login (assistant output after the end) is working again
    assert.equal(state([...turn, reply('e', '55:41', { isApiErrorMessage: true }), td('55:41'), tool('r', '56:00')]), 'working');
    // a task notification or peer message starts a turn; a notification user entry without turnPosition (already handled) doesn't
    assert.equal(state([...turn, td('55:43'), prompt('n', '55:47', 'peer', { isMeta: true }), tool('c', '55:48')]), 'working');
    assert.equal(state([...turn, td('55:43'), prompt('n', '55:47', 'task-notification')]), 'working');
    assert.equal(state([...turn, td('55:43'), { type: 'user', timestamp: at('55:51'), origin: { kind: 'task-notification' }, message: { content: '<task-notification>…' } }]), 'idle');
    // queued messages mid-turn don't end it, and the elapsed time stays on the turn's prompt
    const q = turnState([...turn, queued('55:40'), queued('55:41', 'task-notification'), tool('c', '55:42')], 1_000);
    assert.deepEqual(q, { state: 'working', since: Date.parse(at('55:20')) });
    // asking: a pending AskUserQuestion
    assert.equal(state([...turn, tool('k', '55:42', 'AskUserQuestion')]), 'asking');
    // no turn markers (older Claude Code): the 10 s mtime heuristic
    const old = [{ type: 'user', timestamp: at('55:20'), message: { content: 'fix it' } }, reply('b', '55:39')];
    assert.deepEqual(turnState(old, 1_000), { state: 'working', since: null });
    assert.equal(state(old, 60_000), 'idle');
    // the session list uses it too
    assert.equal(status(turn.at(-1), 5 * 60_000, turnState(turn, 5 * 60_000)), 'working');
    assert.equal(status(turn.at(-1), 5 * 60_000, { state: 'asking' }), 'waiting');
    assert.equal(summarize([...turn, td('55:43')], 1_000).status, 'waiting');
    console.log('ok turn state');
}

import { findClearedSuccessor, tmuxFor, lastActivity } from './server.mjs';
{
    const ts = s => `2026-11-13T10:${s}:00.000Z`;
    const real = [
        { type: 'user', timestamp: ts('00'), message: { role: 'user', content: 'hi' } },
        { type: 'assistant', timestamp: ts('01'), message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
        { type: 'user', timestamp: ts('02'), message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } },
        { type: 'assistant', isSidechain: true, timestamp: ts('03'), message: { content: [{ type: 'text', text: 'side' }] } }
    ];
    const book = [{ type: 'cost-state' }, { type: 'bridge-session' }, { type: 'tools-used' }, { type: 'attachment', timestamp: ts('09'), attachment: { type: 'hook_success' } }];
    assert.equal(lastActivity([...real, ...book]), Date.parse(ts('01')), 'bookkeeping, tool results and sidechains are not activity');
    assert.equal(lastActivity([...real, { type: 'attachment', timestamp: ts('05'), attachment: { type: 'queued_command', prompt: 'q', origin: { kind: 'human' } } }]), Date.parse(ts('05')), 'a queued human prompt is');
    assert.equal(lastActivity(book), null);
    console.log('ok last activity');
}
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

import { clearState, topicHue, TOPIC_HUES, pickChat, newerSession } from './public/chat.js';
{
    // the tracker incident: an idle older session's metadata writes put it first by mtime; the chat must not jump to it
    const T = '/Users/b/tracker';
    const old = { id: 'f67f', project: 'tracker', cwd: T, created: 1 }, live = { id: 'e9c1', project: 'tracker', cwd: `${T}/frontend`, created: 2 };
    const wt = { id: 'wt', project: 'tracker', cwd: `${T}/.claude/worktrees/x`, created: 5 }, side = { id: 'sc', project: 'tracker', cwd: T, sidechain: true, created: 6 };
    assert.equal(pickChat([old, live], 'e9c1', 'other-project').id, 'e9c1', 'bound session sticks though another is newer');
    assert.equal(pickChat([old, live], null, 'gone').id, 'e9c1', 'unbound, no activity known: the later-created master');
    assert.equal(pickChat([wt, side, live], null, null).id, 'e9c1', 'worktree and subagent sessions are never auto-picked');
    assert.equal(pickChat([wt, live], 'wt', null).id, 'wt', 'an explicit pick of one still holds');
    const succ = { id: 'next', project: 'tracker', cwd: T, created: 3, clearedFrom: 'e9c1' };
    assert.equal(pickChat([succ, old, live], 'e9c1', null).id, 'next', 'a Homebase /clear successor takes over');
    assert.equal(pickChat([{ ...succ, clearedFrom: undefined }, old, live], 'e9c1', null).id, 'e9c1', 'a plain newer session does not');
    assert.equal(newerSession([wt, side, old, live], old).id, 'e9c1', 'newer master is offered');
    assert.equal(newerSession([wt, side, old, live], live), null, 'worktree/subagent sessions are not offered');
    assert.equal(newerSession([{ ...succ, project: 'other' }, live], live), null, 'other projects are not offered');
    // fresh profile, nothing bound: /api/sessions lists the idle f67f first (newer mtime), but e9c1 was active last
    const idle = { ...old, updated: 2000, lastActivity: 100 }, active = { ...live, updated: 1000, lastActivity: 900 };
    assert.equal(pickChat([idle, active], null, null).id, 'e9c1', 'unbound: latest real activity, not mtime');
    assert.equal(newerSession([idle, active], active), null, 'an idle older session is not offered as newer');
    console.log('ok chat binding');
}
{
    const topics = ['Chat topic headers', 'Attention colours', 'CI pills', 'Milestone empty states', 'ø', 'x'.repeat(500)];
    for (const t of topics) {
        const h = topicHue(t);
        assert.ok(Number.isInteger(h) && h >= 0 && h < TOPIC_HUES, t);
        assert.equal(topicHue(t), h, 'stable');
    }
    assert.ok(new Set(topics.map(topicHue)).size > 2, 'spreads over hues');
    console.log('ok topic hue');
}
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

import { keyAction, stepKey } from './public/keys.js';
const kev = (key, mods = {}) => ({ key, ...mods });
assert.equal(keyAction(kev('j')), 'next');
assert.equal(keyAction(kev('ArrowUp')), 'prev');
assert.equal(keyAction(kev(' ')), 'toggle');
assert.equal(keyAction(kev('Enter')), 'toggle');
assert.equal(keyAction(kev('/')), 'chat');
assert.equal(keyAction(kev('?', { shiftKey: true })), 'help');
assert.equal(keyAction(kev('p')), null);
assert.equal(keyAction(kev('p'), 'g'), 'project');
assert.equal(keyAction(kev('r')), 'refresh');
assert.equal(keyAction(kev('r', { metaKey: true })), null); // Cmd+R stays the browser's reload
assert.equal(keyAction(kev('j'), 'g'), 'next');
assert.equal(keyAction(kev('k', { metaKey: true })), null); // browser and OS shortcuts pass through
assert.equal(stepKey(['a', 'b', 'c'], 'b', 1), 'c');
assert.equal(stepKey(['a', 'b', 'c'], 'c', 1), 'c'); // clamps
assert.equal(stepKey(['a', 'b', 'c'], 'a', -1), 'a');
assert.equal(stepKey(['a', 'b', 'c'], null, 1), 'a');
assert.equal(stepKey(['a', 'b', 'c'], 'gone', -1), 'c');
assert.equal(stepKey([], 'a', 1), null);
console.log('ok keys');

import { vendorPath } from './server.mjs';
assert.equal(vendorPath('/vendor/webawesome/webawesome.loader.js'), 'webawesome/webawesome.loader.js');
assert.equal(vendorPath('/vendor/fonts/inter-latin-400-normal.woff2'), 'fonts/inter-latin-400-normal.woff2');
assert.equal(vendorPath('/vendor/a%20b.css'), 'a b.css');
for (const p of [
    '/vendor/../server.mjs', '/vendor/%2e%2e/server.mjs', '/vendor/%2E%2E%2Fserver.mjs', '/vendor/a/..%2f..%2fserver.mjs',
    '/vendor/..%5c..%5cserver.js', '/vendor/a%00.js', '/vendor/%E0%A4%A.js', '/vendor//etc/x.js', '/vendor/.hidden.js',
    '/vendor/VENDOR.md', '/vendor/x.html', '/vendor/', '/vendor', '/vendorx/a.js', '/server.mjs', null
]) {
    assert.equal(vendorPath(p), null, p);
}
console.log('ok vendor');

// Every request from the page goes through core.js's api(), which adds the token; a missing import fails silently in a try/catch.
for (const f of readdirSync(new URL('./public', import.meta.url)).filter(f => f.endsWith('.js') && f !== 'core.js')) {
    const src = readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bfetch\(/, `${f} uses fetch() instead of api()`);
    if (/\bapi\(/.test(src)) {
        assert.match(src, /import \{[^}]*\bapi\b[^}]*\} from '\.\/core\.js'/, `${f} calls api() without importing it`);
    }
}
console.log('ok api wrapper');

import { localHosts, lanHosts, isPrivateIp, allowedHost, allowedOrigin, tokenOk, cookieOk, isLoopback, bindOk, rateLimiter, pairingCode } from './server.mjs';
{
    const local = localHosts(4321);
    assert.ok(allowedHost('localhost:4321', local));
    assert.ok(allowedHost('127.0.0.1:4321', local));
    assert.ok(allowedHost('[::1]:4321', local));
    assert.ok(!allowedHost('evil.com', local));
    assert.ok(!allowedHost('localhost:4322', local));
    assert.ok(!allowedHost('localhost', local));
    assert.ok(!allowedHost(undefined, local));
    assert.ok(allowedOrigin(undefined, local));
    assert.ok(allowedOrigin('http://localhost:4321', local));
    assert.ok(allowedOrigin('http://127.0.0.1:4321', local));
    assert.ok(!allowedOrigin('http://evil.com', local));
    assert.ok(!allowedOrigin('null', local));
    assert.ok(!allowedOrigin('https://localhost:4321', local));
    assert.ok(tokenOk('abc', 'abc'));
    assert.ok(!tokenOk('abd', 'abc'));
    assert.ok(!tokenOk('ab', 'abc'));
    assert.ok(!tokenOk(undefined, 'abc'));
    assert.ok(!tokenOk('abc', undefined));
    assert.ok(cookieOk('a=1; homebase_session=s3cret; b=2', 's3cret'));
    assert.ok(!cookieOk('homebase_session=nope', 's3cret'));
    assert.ok(!cookieOk(undefined, 's3cret'));
    assert.ok(!cookieOk('homebase_session=', undefined));
    assert.ok(isLoopback('127.0.0.1') && isLoopback('::1') && !isLoopback('192.168.1.5'));
    assert.ok(bindOk('127.0.0.1', false) && !bindOk('0.0.0.0', false) && bindOk('0.0.0.0', true) && !bindOk('192.168.1.5', true));
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.5']) {
        assert.ok(isPrivateIp(ip), ip);
    }
    for (const ip of ['172.15.0.1', '172.32.0.1', '8.8.8.8', '127.0.0.1', 'fe80::1', undefined]) {
        assert.ok(!isPrivateIp(ip), ip);
    }
    const ifaces = { lo0: [{ address: '127.0.0.1' }], en0: [{ address: 'fe80::1' }, { address: '192.168.1.5' }], utun: [{ address: '100.64.0.1' }] };
    assert.deepEqual(lanHosts(4321, 'Mac', ifaces), [...local, 'mac.local:4321', '192.168.1.5:4321']);
    assert.deepEqual(lanHosts(4321, 'Mac.local', {}), [...local, 'mac.local:4321']);
    const hit = rateLimiter(5, 60_000, 900_000);
    for (let i = 0; i < 5; i++) {
        assert.ok(hit('a', 1000));
    }
    assert.ok(!hit('a', 1000)); // 6th try locks out
    assert.ok(hit('b', 1000)); // per key
    assert.ok(!hit('a', 70_000)); // still locked after the window
    assert.ok(hit('a', 1000 + 900_001)); // lock expired
    const hit2 = rateLimiter(2, 60_000, 900_000);
    assert.ok(hit2('c', 0) && hit2('c', 0) && hit2('c', 61_000)); // window resets
    assert.match(pairingCode(), /^[A-HJ-NP-Z2-9]{8}$/);
}
console.log('ok access checks');

import { refetch, refreshDue } from './server.mjs';
{
    // the old value serves until the new one lands; a second call while in flight shares the fetch
    let calls = 0, release;
    const hit = { at: 5, value: 'old' }, fn = () => { calls++; return new Promise(r => { release = r; }); };
    const p = refetch(hit, fn);
    assert.equal(refetch(hit, fn), p);
    assert.equal(calls, 1);
    assert.equal(hit.value, 'old');
    release('new'); await p;
    assert.equal(hit.value, 'new');
    assert.equal(hit.pending, null);
    assert.ok(hit.at > 5);
    // a failure keeps the value and records the error
    await refetch(hit, () => Promise.reject(new Error('down')));
    assert.equal(hit.value, 'new');
    assert.equal(hit.error.message, 'down');

    assert.ok(refreshDue(false, 0, 10_000));
    assert.ok(!refreshDue(true, 0, 10_000)); // one running
    assert.ok(!refreshDue(false, 6_000, 10_000)); // started 4 s ago
    assert.ok(refreshDue(false, 5_000, 10_000));
}
console.log('ok refresh');

import { swrEntry, swr, cached, refreshAll, refreshInfo } from './server.mjs';
{
    // refreshAll: the other cache entries first, the issue groups once those are in; concurrent calls share one run
    const order = [];
    let linkCalls = 0, release;
    const links = () => {
        order.push('links');
        return linkCalls++ ? new Promise(r => { release = r; }) : Promise.resolve(1);
    };
    const issues = () => {
        order.push('issues');
        return Promise.resolve(2);
    };
    await swrEntry('links:p:1', 1e9, links).pending;
    await swrEntry('issues:p:11', 1e9, issues).pending;
    order.length = 0;
    const run = refreshAll();
    assert.equal(refreshAll(), run);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(order, ['links']);
    assert.equal(refreshInfo().refreshing, true);
    release(1);
    await run;
    assert.deepEqual(order, ['links', 'issues']);
    assert.equal(refreshInfo().refreshing, false);

    // cached: only the first load waits, a stale entry answers with the old value at once, a failed first load throws
    assert.equal(await cached('t:a', 0, () => Promise.resolve(1)), 1);
    let settled = false;
    const stale = cached('t:a', -1, () => new Promise(() => {})).then(v => {
        settled = true;
        return v;
    });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(settled, true);
    assert.equal(await stale, 1);
    await assert.rejects(cached('t:b', 1e9, () => Promise.reject(new Error('down'))), /down/);
    for (const k of ['links:p:1', 'issues:p:11', 't:a', 't:b']) {
        swr.delete(k);
    }
}
console.log('ok refreshAll, cached');

// Integration: real server on a random port, over a temp HOME and data dir and a tmux socket nobody uses. Only GETs, rejected POSTs and a refresh with nothing to refresh.
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
{
    const freePort = () => new Promise(r => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const call = (port, { host, path = '/', method = 'GET', headers = {}, body, addr = '127.0.0.1' } = {}) => new Promise((ok, fail) => {
        const r = request({ host: addr, port, path, method, headers: { host: host ?? `localhost:${port}`, ...headers } }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', fail);
        r.end(body);
    });
    async function start(env) {
        const port = await freePort(), dir = mkdtempSync(join(tmpdir(), 'homebase-test-'));
        const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url).pathname, env: { ...process.env, HOME: dir, PORT: String(port), HOMEBASE_DIR: dir, HOMEBASE_STATUSLINE_DIR: dir, HOMEBASE_TMUX_SOCKET: 'homebase-test-none', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        await new Promise((ok, fail) => { child.stdout.on('data', c => { out += c; if (out.includes('Homebase on')) ok(); }); child.on('exit', fail); });
        return { port, dir, out, stop: () => { child.kill(); rmSync(dir, { recursive: true, force: true }); } };
    }
    const meta = body => body.match(/name="homebase-token" content="([0-9a-f]{64})"/)?.[1];

    const s = await start({});
    try {
        assert.equal((await call(s.port, { host: 'evil.com' })).status, 403);
        assert.equal((await call(s.port, { host: 'evil.com', path: '/api/limits' })).status, 403);
        assert.equal((await call(s.port, { headers: { origin: 'http://evil.com' } })).status, 403);
        assert.equal((await call(s.port, { path: '/api/limits' })).status, 401);
        assert.equal((await call(s.port, { path: '/api/limits', headers: { 'x-homebase-token': 'f'.repeat(64) } })).status, 401);
        const page = await call(s.port);
        assert.equal(page.status, 200);
        assert.equal(page.headers['x-content-type-options'], 'nosniff');
        assert.equal(page.headers['x-frame-options'], 'DENY');
        assert.equal(page.headers['referrer-policy'], 'no-referrer');
        assert.match(page.headers['content-security-policy'], /script-src 'self';/);
        const token = meta(page.body);
        assert.ok(token, 'page carries the token');
        assert.match(page.body, /name="homebase-build" content="[\w-]{12}"/);
        assert.equal(page.headers['cache-control'], 'no-store');
        for (const path of ['/app.js', '/styles.css', '/vendor/marked/marked.min.js']) {
            const js = await call(s.port, { path });
            assert.equal(js.status, 200);
            assert.equal(js.headers['cache-control'], 'no-cache', path); // revalidate every load: no stale modules after a restart
            assert.match(js.headers.etag, /^"[\w-]+"$/, path);
            const again = await call(s.port, { path, headers: { 'if-none-match': js.headers.etag } });
            assert.equal(again.status, 304, path);
            assert.equal(again.body, '');
            assert.equal((await call(s.port, { path, headers: { 'if-none-match': '"stale"' } })).status, 200, path);
        }
        const ok = await call(s.port, { path: '/api/limits', headers: { 'x-homebase-token': token, origin: `http://localhost:${s.port}` } });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers['content-type'], 'application/json');
        // POST rejection paths only: none of these reach a session.
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1' }, body: 'hi' })).status, 401);
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, 'sec-fetch-site': 'cross-site' }, body: 'hi' })).status, 403);
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, origin: 'http://evil.com' }, body: 'hi' })).status, 403);
        assert.equal((await call(s.port, { path: '/pair', method: 'POST', body: 'code=x' })).status, 404); // no pairing outside LAN mode
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-codetool': '1' } })).status, 401);
        // without x-codetool a POST matches no route, even with the token
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-homebase-token': token }, body: 'hi' })).status, 404);
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-homebase-token': token } })).status, 404);
        // only known sessions and plain transcript folders; HOME is empty, so nothing reaches tmux
        const authed = { 'x-homebase-token': token };
        for (const dir of ['..', 'a%2Fb']) {
            assert.deepEqual((({ status, body }) => [status, body])(await call(s.port, { path: `/api/transcript?dir=${dir}&id=x`, headers: authed })), [500, 'bad path'], dir);
        }
        const sent = await call(s.port, { path: '/api/send?id=..%2Fx', method: 'POST', headers: { ...authed, 'x-codetool': '1' }, body: 'hi' });
        assert.deepEqual([sent.status, sent.body], [500, 'bad id']);
        const refreshed = await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token } });
        assert.equal(refreshed.status, 200);
        assert.equal(JSON.parse(refreshed.body).refreshing, false);
        assert.ok(JSON.parse(refreshed.body).lastRefreshedAt > 0);
        // an unknown project: a 404 that still carries the final empty state, so the pill stops loading
        const unknown = await call(s.port, { path: '/api/milestones?project=no-such-project-xyz&milestone=', headers: { 'x-homebase-token': token } });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.headers['content-type'], 'application/json'); // the error body is JSON too
        assert.deepEqual((({ milestones, selected, loading, reason }) => ({ milestones, selected, loading, reason }))(JSON.parse(unknown.body)),
            { milestones: [], selected: null, loading: false, reason: 'unsupported' });
    } finally { s.stop(); }
    console.log('ok server access');

    // LAN mode: a non-loopback client must reach us on a private address of this machine; skip without one.
    const lanIp = lanHosts(0).map(h => h.replace(/:0$/, '')).find(isPrivateIp);
    if (!lanIp) {
        console.log('skip LAN mode test: no private IPv4 address');
    } else {
        const l = await start({ HOMEBASE_LAN: '1' });
        try {
            const code = readFileSync(join(l.dir, 'pairing-code'), 'utf8').trim();
            assert.match(l.out, new RegExp(`pairing code ${code}`));
            assert.equal(statSync(join(l.dir, 'pairing-code')).mode & 0o777, 0o600);
            assert.equal(statSync(join(l.dir, 'session-secret')).mode & 0o777, 0o600);
            const host = `${lanIp}:${l.port}`, lan = { addr: lanIp, host };
            assert.equal((await call(l.port, { ...lan, host: 'evil.com' })).status, 403);
            const pairing = await call(l.port, lan);
            assert.equal(pairing.status, 200);
            assert.match(pairing.body, /Pair this device/);
            assert.match(pairing.headers['content-security-policy'], /script-src 'self';.*form-action 'self'/);
            assert.doesNotMatch(pairing.body, /<script|\son[a-z]+=/i); // nothing the CSP would block
            assert.equal(meta(pairing.body), undefined);
            assert.equal((await call(l.port, { ...lan, path: '/app.js' })).status, 401);
            assert.equal((await call(l.port, { ...lan, path: '/api/limits' })).status, 401);
            const form = { 'content-type': 'application/x-www-form-urlencoded', origin: `http://${host}` };
            assert.equal((await call(l.port, { ...lan, path: '/pair', method: 'POST', headers: form, body: 'code=WRONG123' })).status, 403);
            const paired = await call(l.port, { ...lan, path: '/pair', method: 'POST', headers: form, body: `code=${code.toLowerCase()}` });
            assert.equal(paired.status, 303);
            const cookie = paired.headers['set-cookie'][0];
            assert.match(cookie, /HttpOnly; SameSite=Strict/);
            const jar = cookie.split(';')[0];
            const app = await call(l.port, { ...lan, headers: { cookie: jar } });
            assert.equal(app.status, 200);
            const token = meta(app.body);
            assert.ok(token, 'paired device gets the token');
            assert.equal((await call(l.port, { ...lan, path: '/api/limits', headers: { cookie: jar, 'x-homebase-token': token } })).status, 200);
            assert.equal((await call(l.port, { ...lan, path: '/api/limits', headers: { 'x-homebase-token': token } })).status, 401); // token alone isn't enough off-machine
            assert.ok(meta((await call(l.port)).body), 'loopback needs no pairing');
            for (let i = 0; i < 3; i++) {
                assert.equal((await call(l.port, { ...lan, path: '/pair', method: 'POST', headers: form, body: 'code=WRONG123' })).status, 403);
            }
            assert.equal((await call(l.port, { ...lan, path: '/pair', method: 'POST', headers: form, body: `code=${code}` })).status, 429); // 6th try: locked out, even with the right code
        } finally { l.stop(); }
        console.log('ok LAN pairing');
    }
}

import { limiter, dedupe } from './server.mjs';
{
    // at most 2 run at once, in call order, and a rejection doesn't stall the queue
    const slot = limiter(2), started = [];
    let active = 0, peak = 0;
    const job = (n, fail) => slot(async () => {
        started.push(n); peak = Math.max(peak, ++active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        if (fail) {
            throw new Error(`job ${n}`);
        }
        return n;
    });
    const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
    assert.equal(peak, 2);
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    assert.deepEqual(results.map(r => r.value ?? r.reason.message), [1, 'job 2', 3, 4, 5]);

    // concurrent calls for one key share a single run; after it settles the next call runs again
    const once = dedupe();
    let runs = 0;
    const call = k => once(k, async () => { runs++; await new Promise(r => setTimeout(r, 5)); return k; });
    assert.deepEqual(await Promise.all([call('a'), call('a'), call('b')]), ['a', 'a', 'b']);
    assert.equal(runs, 2);
    await call('a');
    assert.equal(runs, 3);
    await assert.rejects(once('x', () => { throw new Error('sync'); }), /sync/); // a throwing fn rejects, it doesn't throw
    assert.equal(await once('x', () => 'again'), 'again'); // and doesn't stick
    console.log('ok limiter dedupe');
}

import { api, page, refreshToken } from './public/core.js';
import { saveDraft, restoreDraft } from './public/chat.js';
{
    // A stub server: /api/* wants the current token, / serves the page with the token and build it has now.
    const real = globalThis.fetch, calls = [], codetool = [];
    let current = 'new', serveToken = 'new', build = 'b2';
    globalThis.fetch = async (path, opts = {}) => {
        calls.push(path);
        codetool.push([path, opts.headers?.['x-codetool']]);
        await new Promise(r => setTimeout(r, 2));
        if (path === '/') {
            return new Response(`<meta name="homebase-token" content="${serveToken}"><meta name="homebase-build" content="${build}">`);
        }
        return new Response('ok', { status: opts.headers['x-homebase-token'] === current ? 200 : 401 });
    };
    const count = p => calls.filter(c => c === p).length;
    try {
        // three concurrent 401s share one token fetch, then each retries once with the new token
        Object.assign(page, { token: 'old', build: 'b1', updated: false });
        const rs = await Promise.all([api('/api/a'), api('/api/b'), api('/api/c', { method: 'POST' })]);
        assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
        assert.equal(count('/'), 1);
        assert.deepEqual([count('/api/a'), count('/api/b'), count('/api/c')], [2, 2, 2]);
        // the retried POST still carries x-codetool, the GETs never do
        assert.deepEqual(codetool.filter(([p]) => p.startsWith('/api/')).map(([p, h]) => `${p}:${h}`).sort(), ['/api/a:undefined', '/api/a:undefined', '/api/b:undefined', '/api/b:undefined', '/api/c:1', '/api/c:1']);
        assert.equal(page.token, 'new');
        assert.equal(page.updated, true, 'a different build id flags the update');
        // the new token works: no refresh
        calls.length = 0;
        assert.equal((await api('/api/a')).status, 200);
        assert.deepEqual(calls, ['/api/a']);
        // the refreshed token still fails: one refresh, one retry, then the 401 goes back to the caller (no loop)
        calls.length = 0; current = 'other'; serveToken = 'newer';
        assert.equal((await api('/api/a')).status, 401);
        assert.deepEqual(calls, ['/api/a', '/', '/api/a']);
        // a page without a token (server down, pairing page): no retry at all
        calls.length = 0; serveToken = '';
        assert.equal((await api('/api/a')).status, 401);
        assert.deepEqual(calls, ['/api/a', '/']);
        // same build: no update note
        Object.assign(page, { build: 'b2', updated: false });
        await refreshToken();
        assert.equal(page.updated, false);
    } finally { globalThis.fetch = real; }

    // draft round trip with the selection; per session; never overwrites typed text; empty text removes it
    const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    const ta = (value = '', start = 0, end = 0) => ({ value, selectionStart: start, selectionEnd: end, setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; } });
    saveDraft(storage, 's1', ta('hello world', 6, 11));
    const back = ta();
    assert.equal(await restoreDraft(storage, 's1', back), true);
    assert.deepEqual([back.value, back.selectionStart, back.selectionEnd], ['hello world', 6, 11]);
    assert.equal(await restoreDraft(storage, 's2', ta()), false);
    const typed = ta('new');
    assert.equal(await restoreDraft(storage, 's1', typed), false);
    assert.equal(typed.value, 'new');
    saveDraft(storage, 's1', ta(''));
    assert.equal(mem.has('draft:s1'), false);
    saveDraft(null, 's1', ta('x')); // no storage: no throw
    assert.equal(await restoreDraft(null, 's1', ta()), false);
    console.log('ok token refresh, draft');
}

import { issueOf, mentionsMr, turnPrompts, spawnPrompts, worksOnMr, requestFor } from './server.mjs';
{
    const url = 'https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1785';
    assert.equal(issueOf('#2219 - Auto booked creator', ''), '2219');
    assert.equal(issueOf('Auto booked creator', 'Some text.\n\nCloses #2219'), '2219');
    assert.equal(issueOf('Auto booked creator', null), null);
    // the row button's own message, a bare !N, the issue; not a longer number, an issue ref of the MR number, or &epic
    assert.equal(mentionsMr(`Address the review comments on !1785 (${url}), push, and reply in each thread.`, url, '2219'), true);
    assert.equal(mentionsMr('check !1785 again', url, null), true);
    assert.equal(mentionsMr('how is #2219 going?', url, '2219'), true);
    assert.equal(mentionsMr('look at !17850 and #22190', url, '2219'), false);
    assert.equal(mentionsMr('issue #1785 and &2219', url, '2219'), false);
    assert.equal(mentionsMr('look at #12', 'https://github.com/o/r/pull/12', null), true);

    // turn prompts, from real entry shapes: a typed turnPosition prompt and a human queued_command attachment
    const at = s => `2026-11-13T10:${s}.000Z`;
    const prompt = (s, text, extra = {}) => ({ type: 'user', isSidechain: false, uuid: s, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 74, turnIndex: 136 }, message: { role: 'user', content: text }, ...extra });
    const queued = (s, text, kind = 'human') => ({ type: 'attachment', isSidechain: false, timestamp: at(s), attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind }, humanTurn: true } });
    const td = s => ({ type: 'system', subtype: 'turn_duration', timestamp: at(s) });
    const tool = s => ({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id: `t${s}`, name: 'Bash', input: {} }] } });
    const ask = prompt('12:00', `Address the review comments on !1785 (${url}), push, and reply in each thread.`);
    assert.deepEqual(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000).map(p => p.text.slice(0, 33)), ['Address the review comments on !1']);
    assert.deepEqual(turnPrompts([td('11:00'), ask, tool('12:05'), td('12:30')], 1_000), []);
    assert.deepEqual(turnPrompts([td('11:00'), prompt('12:00', 'unrelated'), queued('12:10', 'and #2219?'), queued('12:11', 'note', 'task-notification')], 1_000).map(p => p.text), ['unrelated', 'and #2219?']);
    // a turn a task notification started has no human prompt
    assert.deepEqual(turnPrompts([td('11:00'), prompt('12:00', '<task-notification>…</task-notification>', { origin: { kind: 'task-notification' } })], 1_000), []);

    // requested: shown as doing without a button while the turn is open and no agent runs for it
    const pr = { state: 'open', changes: true, reviewers: ['Ann'], branch: '2219-auto-booked-creator', issue: '2219', title: '#2219 - Auto booked creator' };
    const master = (openPrompts, agents = []) => ({ id: 'm', project: 'pracsys', prs: [{ url, at: 1 }], agents, openPrompts });
    const one = (s, prOf = () => pr) => workItems([s], prOf, 0, new Map())[0];
    const req = one(master(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000)));
    assert.deepEqual([req.column, req.next, req.action, req.requested.at], ['doing', 'Claude is on it…', null, at('12:00')]);
    const idle = one(master([]));
    assert.deepEqual([idle.column, idle.requested, idle.action.label], ['needs-you', null, 'Fix & reply']);
    // another project's session asking about the same number doesn't count
    assert.equal(requestFor([{ project: 'other', openPrompts: [{ at: at('12:00'), text: 'fix !1785' }] }], 'pracsys', url, pr), null);

    // agent linking: branch, issue in the description, issue/!N/URL in the prompt; done agents only by !N in the description
    const ag = extra => ({ id: 'a', status: 'running', stage: 1, updated: 5, prs: [], description: 'Implement thing', prompt: '', branches: ['worktree-agent-a'], ...extra });
    assert.equal(worksOnMr(ag({ branches: ['worktree-agent-a', '2219-auto-booked-creator'] }), url, pr), true);
    assert.equal(worksOnMr(ag({ description: 'Implement #2219 auto booked' }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: 'Implement GitLab issue #2219 in pracsys' }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: `Fix the comments on ${url}` }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: 'Fix the comments on !1785' }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: 'Implement #2220' }), url, pr), false);
    // only the prompt's first refs count: issues listed for context don't link
    assert.equal(worksOnMr(ag({ prompt: 'Implement issue #2220. Related: #2219 already shipped.' }), url, pr), false);
    assert.equal(worksOnMr(ag({ prompt: 'Simulate an accountant. Known bugs: #2217, #2218, #2219, #2220.' }), url, pr), false);
    assert.equal(worksOnMr(ag({ status: 'done', prompt: 'Implement #2219' }), url, pr), false);
    assert.equal(worksOnMr(ag({ status: 'done', description: 'Rebase !1785' }), url, pr), true);
    // a running linked agent takes over from requested: its stage line, no button
    const linked = one(master(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000), [ag({ description: 'Fix #2219 review' })]));
    assert.deepEqual([linked.column, linked.next, linked.action, linked.requested, linked.agentStatus], ['doing', 'Fix #2219 review is implementing…', null, null, 'running']);
    // no cross-project match: the same issue number and branch in another project's agent stays loose
    const cross = workItems([master([]), { id: 'o', project: 'other', prs: [], agents: [ag({ id: 'x', description: 'Implement #2219', branches: ['2219-auto-booked-creator'] })] }], () => pr, 0, new Map());
    assert.deepEqual(cross.map(i => [i.key, i.column]), [[url, 'needs-you'], ['x', 'doing']]);

    // spawn links, from real shapes: the master's Agent tool_use, its launch result, and the subagent meta's toolUseId
    const spawn = (s, id, description) => ({ type: 'assistant', isSidechain: false, timestamp: at(s), message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description, isolation: 'worktree', prompt: 'Run the review-gate skill.' } }] } });
    const launched = (s, id, agentId) => ({ type: 'user', isSidechain: false, timestamp: at(s), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` }] }] } });
    const note = (s, agentId) => prompt(s, `<task-notification>\n<task-id>${agentId}</task-id>\n<output-file>/tmp/${agentId}.output</output-file>\n<status>completed</status>\n</task-notification>`, { origin: { kind: 'task-notification' } });
    const url2 = 'https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1784';
    const spawns = spawnPrompts([
        td('11:00'), prompt('12:00', `Run review-gate on !1785 (${url}). If ready, merge it.`), spawn('12:01', 'toolu_gate', 'Gate: code review'), launched('12:02', 'toolu_gate', 'agate'), td('12:03'),
        prompt('13:00', 'Merge !1784 and !1785'), spawn('13:01', 'toolu_both', 'Merge both'), td('13:02'),
        prompt('14:00', 'Tidy the README'), spawn('14:01', 'toolu_other', 'Gate: rules compliance'), td('14:02'),
        note('15:00', 'agate'), spawn('15:01', 'toolu_merge', 'Merge after the gate'), td('15:02')
    ]);
    assert.deepEqual([...spawns.keys()], ['toolu_gate', 'toolu_both', 'toolu_other', 'toolu_merge']);
    assert.equal(spawns.get('toolu_merge'), spawns.get('toolu_gate')); // a task-notification turn inherits the notifying agent's prompt
    const gateAgent = (toolUseId, extra) => ag({ description: 'Gate: code review', prompt: 'Review the diff in the worktree.', spawnedFor: spawns.get(toolUseId), ...extra });
    assert.equal(worksOnMr(gateAgent('toolu_gate'), url, pr), true);
    assert.deepEqual([url, url2].map(u => worksOnMr(gateAgent('toolu_both'), u, { ...pr, issue: null })), [true, true]);
    assert.equal(worksOnMr(gateAgent('toolu_other'), url, pr), false);
    assert.equal(worksOnMr(gateAgent('toolu_gate', { status: 'done' }), url, pr), false);
    // the master's turn has ended, yet the MR stays doing while the gate it spawned runs
    const ready = { ...pr, changes: false, ready: true };
    const gated = one(master([], [gateAgent('toolu_gate')]), () => ready);
    assert.deepEqual([gated.column, gated.next, gated.action, gated.agentStatus], ['doing', 'Gate: code review is implementing…', null, 'running']);
    assert.equal(one(master([], [gateAgent('toolu_other')]), () => ready).action.label, 'Merge + close issue');
    console.log('ok requested, agent links');
}

// tracker e9c15e3f: a ~900 KB tool_result line filled the 512 KB tail, so the chat showed one bubble and the 403 vanished
import { readTail } from './server.mjs';
{
    const f = join(mkdtempSync(join(tmpdir(), 'hb-')), 't.jsonl');
    const ts = '2026-11-13T10:15:47.041Z';
    const lines = [
        { type: 'user', message: { role: 'user', content: 'weight OC roles for new players' }, timestamp: '2026-11-13T10:10:00.000Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done, roles are weighted.' }] }, timestamp: '2026-11-13T10:12:00.000Z' },
        { type: 'assistant', isApiErrorMessage: true, error: 'authentication_failed', apiErrorStatus: 403, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'Please run /login · API Error: 403 Attention Required! | Cloudflare' }] }, timestamp: ts },
        { type: 'system', subtype: 'turn_duration', timestamp: ts },
        { type: 'user', message: { role: 'user', content: 'try again' }, timestamp: '2026-11-13T10:28:41.000Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'curl' } }] }, timestamp: '2026-11-13T10:28:51.000Z' },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(900_000) }] }, timestamp: '2026-11-13T10:28:51.000Z' },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'It still shows no booster cooldown.' }] }, timestamp: '2026-11-13T10:28:57.000Z' }
    ];
    writeFileSync(f, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const items = chatItems(await readTail(f, statSync(f).size));
    assert.deepEqual(items.map(i => [i.role, i.text.slice(0, 17)]), [
        ['user', 'weight OC roles f'], ['assistant', 'Done, roles are w'], ['error', 'Please run /login'],
        ['user', 'try again'], ['tools', 'Ran 1 command'], ['assistant', 'It still shows no']
    ]);
    console.log('ok big-line tail, api error line');
}

// A half-written agent .meta.json or a transcript deleted mid-poll skips that one entry, not the whole /api/sessions
import { fetchComments } from './server.mjs';
{
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir = join(home, '.claude', 'projects', 'p');
    const subs = join(dir, 'good', 'subagents');
    mkdirSync(subs, { recursive: true });
    const at = new Date().toISOString();
    writeFileSync(join(dir, 'good.jsonl'), JSON.stringify({ type: 'user', sessionId: 'good', message: { content: 'hi' }, timestamp: at }) + '\n');
    symlinkSync(join(dir, 'nowhere.jsonl'), join(dir, 'gone.jsonl')); // listed by readdir, gone on stat
    const agentLine = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, timestamp: at }) + '\n';
    writeFileSync(join(subs, 'bad.jsonl'), agentLine);
    writeFileSync(join(subs, 'bad.meta.json'), '{"descrip');
    writeFileSync(join(subs, 'ok.jsonl'), agentLine);
    writeFileSync(join(subs, 'ok.meta.json'), JSON.stringify({ description: 'ok agent', finished: true }));
    // ROOT comes from HOME at import, so sessions() runs in a child with HOME pointing at the fixture
    const code = "import { sessions } from './server/sessions.mjs'; console.log(JSON.stringify((await sessions()).map(s => [s.id, s.items.map(i => i.key)])));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, cwd: import.meta.dirname, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), [['good', ['ok']]]);
    rmSync(home, { recursive: true, force: true });

    assert.deepEqual((await fetchComments('https://example.com/a/b/issues/1')).items, []);
    console.log('ok corrupt meta, vanished transcript, unknown host');
}

import { latestTopic, queuedPrompts } from './server.mjs';
{
    const reply = (text, extra = {}) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra });
    assert.equal(latestTopic([reply('**▸ Old**\nx'), reply('**▸ Perks simulator**\ny'), reply('no header'), { type: 'user', message: { content: 'q' } }]), 'Perks simulator', 'newest reply with a topic');
    assert.equal(latestTopic([reply('**▸ Main**\nx'), reply('**▸ Side**\ny', { isSidechain: true })]), 'Main', 'sidechain replies are skipped');
    assert.equal(latestTopic([reply('plain')]), null);
    console.log('ok latestTopic');

    // pracsys 13 Nov 10:56-10:57Z: "Implement #2244" starts a turn, "Implement #2225" is typed mid-turn (enqueue),
    // absorbed into the running turn (remove + queued_command attachment); entry shapes trimmed to the fields read.
    const sid = '5010a555', ts = s => `2026-11-13T10:${s}Z`;
    const typed = { parentUuid: 'p0', isSidechain: false, type: 'user', message: { role: 'user', content: 'Implement #2244' }, uuid: 'u1', timestamp: ts('56:52.953'), origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 76, turnIndex: 123 }, cwd: '/r/pracsys', sessionId: sid };
    const tool = (uuid, at) => ({ parentUuid: 'x', isSidechain: false, type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', id: `t${uuid}`, name: 'Bash', input: {} }] }, uuid, timestamp: ts(at), sessionId: sid });
    const result = (uuid, at) => ({ parentUuid: 'x', isSidechain: false, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }, uuid, timestamp: ts(at), sessionId: sid });
    const enqueue = { type: 'queue-operation', operation: 'enqueue', timestamp: ts('57:03.798'), sessionId: sid, content: 'Implement #2225' };
    const notify = { type: 'queue-operation', operation: 'enqueue', timestamp: ts('57:04.000'), sessionId: sid, content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>' };
    const dequeue = { type: 'queue-operation', operation: 'dequeue', timestamp: ts('57:05.000'), sessionId: sid };
    const remove = { type: 'queue-operation', operation: 'remove', timestamp: ts('57:15.989'), sessionId: sid, content: 'Implement #2225', reason: 'absorbed_mid_turn', commandUuid: 'ca2b', deliveryId: '9e67' };
    const absorbed = { parentUuid: 'b808', isSidechain: false, attachment: { type: 'queued_command', prompt: 'Implement #2225', source_uuid: 'ca2b', delivery_id: '9e67', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: ts('57:03.749'), humanTurn: true }, type: 'attachment', uuid: '0d72', timestamp: ts('57:03.749') };
    const head = [typed, tool('a1', '56:57.472'), result('u2', '57:02.825')];

    const waiting = [...head, enqueue, tool('a2', '57:15.371')];
    assert.deepEqual(queuedPrompts(waiting).map(q => q.text), ['Implement #2225'], 'typed mid-turn, still queued');
    assert.deepEqual(queuedPrompts([...waiting, notify]).map(q => q.text), ['Implement #2225'], 'task notifications are not human prompts');
    assert.deepEqual(queuedPrompts([enqueue, notify, dequeue]).map(q => q.text), [], 'dequeue takes the head');
    let s = summarize(waiting, 1_000);
    assert.deepEqual([s.status, s.now, s.queued], ['working', 'Implement #2244', ['Implement #2225']]);

    const taken = [...waiting, result('b808', '57:15.972'), remove, absorbed];
    assert.deepEqual(queuedPrompts(taken), [], 'absorbed mid-turn leaves the queue');
    s = summarize(taken, 1_000);
    assert.deepEqual([s.status, s.now, s.queued], ['working', 'Implement #2225', []], 'the absorbed prompt is what the turn is on now');
    s = summarize([...taken, { type: 'system', subtype: 'turn_duration', timestamp: ts('59:00.000'), isSidechain: false }], 1_000);
    assert.deepEqual([s.status === 'working', s.now], [false, null], 'turn over, nothing now');
    console.log('ok queuedPrompts');
}

import { sessionRows, sessionTopic, sessionState, startingIssues } from './public/list.js';
{
    const ses = (id, project, at, extra = {}) => /** @type {any} */ ({ id, project, lastActivity: at, cwd: `/r/${project}`, sidechain: false, ...extra });
    const list = [ses('a', 'p', 1), ses('b', 'p', 3), ses('c', 'p', 2), ses('d', 'q', 5), ses('w', 'p', 9, { cwd: '/r/p/.claude/worktrees/x' }), ses('s', 'p', 9, { sidechain: true })];
    assert.deepEqual(sessionRows(list).map(g => [g.project, g.shown.map(s => s.id), g.hidden]), [['q', ['d'], 0], ['p', ['b'], 2]], 'folded: the newest');
    assert.deepEqual(sessionRows(list, new Set(), 'a').find(g => g.project === 'p').shown.map(s => s.id), ['a'], 'folded: the chat session');
    assert.deepEqual(sessionRows(list, new Set(['p'])).map(g => [g.project, g.shown.map(s => s.id), g.hidden]), [['q', ['d'], 0], ['p', ['b', 'c', 'a'], 0]]);
    assert.equal(sessionTopic({ topic: 'Perks simulator', lastPrompt: 'x' }), 'Perks simulator');
    assert.equal(sessionTopic({ topic: null, lastPrompt: '**fix** the  build' }), 'fix the build');
    assert.ok(sessionTopic({ topic: null, lastPrompt: 'word '.repeat(40) }).endsWith('…'));
    const now = Date.now();
    assert.deepEqual(sessionState(ses('x', 'p', now - 12 * 60_000, { status: 'idle' })), { kind: 'idle', text: 'idle' });
    assert.deepEqual(sessionState(ses('x', 'p', now, { status: 'working', since: now - 5 * 60_000 })), { kind: 'working', text: 'working 5m' });
    assert.equal(sessionState(ses('x', 'p', now, { status: 'waiting', asking: true })).kind, 'asking');

    const m = ses('m', 'p', now, { status: 'working', now: 'Implement #2225', queued: ['then #2230 and #2231', 'Implement #2225'] });
    assert.deepEqual(startingIssues(m, []), ['2225', '2230', '2231']);
    const items = /** @type {any[]} */ ([{ title: 'Implement #2230 foo', branch: null }, { title: 'x', branch: '2231-bar' }, { title: 'y', prState: { issue: '2225' } }]);
    assert.deepEqual(startingIssues(m, items), [], 'a subagent title, branch or MR issue covers it');
    assert.deepEqual(startingIssues({ ...m, status: 'idle', queued: [] }, []), [], 'turn over: no placeholder');
    assert.deepEqual(startingIssues({ ...m, now: 'see !2225 and #22250', queued: [] }, [{ title: '#2225' }]), ['22250'], 'MR refs are not issues; #2225 does not cover #22250');
    console.log('ok sessionRows');
}

import { parseLog, branchOf, markPushed, chatMilestones, nestCommits, groupByDay } from './server.mjs';
{
    const US = '\x1f';
    const out = [['a'.repeat(40), 'aaaaaaa', '1700000300', 'refs/heads/main', 'Add perks simulator'], ['b'.repeat(40), 'bbbbbbb', '1700000200', 'refs/remotes/origin/main', `Fix a${US}b`],
        ['c'.repeat(40), 'ccccccc', '1700000100', 'refs/heads/worktree-agent-x', 'Agent work']].map(f => f.join(US)).join('\n') + '\n';
    const parsed = parseLog(out);
    assert.deepEqual(parsed.map(c => [c.short, c.at, c.subject]), [['aaaaaaa', 1700000300000, 'Add perks simulator'], ['bbbbbbb', 1700000200000, `Fix a${US}b`], ['ccccccc', 1700000100000, 'Agent work']]);
    assert.deepEqual(['refs/heads/a/b', 'refs/remotes/origin/main', 'refs/tags/v1', 'HEAD'].map(branchOf), ['a/b', 'main', 'v1', 'HEAD']);

    // local-only: a (on main) and c (agent branch); only a is on main
    const marked = markPushed(parsed, `${'a'.repeat(40)}\n${'c'.repeat(40)}\n`, `${'a'.repeat(40)}\n`, 'main', true);
    assert.deepEqual(marked.map(c => [c.branch, c.pushed, c.unpushed]), [['main', false, true], ['main', true, false], ['worktree-agent-x', false, false]]);
    assert.deepEqual(markPushed(parsed, '', '', 'main', false).map(c => [c.pushed, c.unpushed]), [[null, false], [null, false], [null, false]], 'no remote refs: no badges');

    assert.deepEqual(chatMilestones([
        { at: 1, topic: null, tldr: 'before any topic' }, { at: 2, topic: 'Login', tldr: null }, { at: 3, topic: 'Login', tldr: 'fixed' },
        { at: 4, topic: null, tldr: 'pushed' }, { at: 5, topic: 'Release', tldr: 'tagged' }, { at: 6, topic: 'Login', tldr: null }
    ]), [{ at: 4, topic: 'Login', tldr: 'pushed' }, { at: 5, topic: 'Release', tldr: 'tagged' }, { at: 6, topic: 'Login', tldr: null }], 'one line per topic change, newest TLDR');

    const H = 3600_000, c = (hash, at, branch) => ({ hash: hash.repeat(40), short: hash.repeat(7), at, branch });
    const agents = [
        { id: 'build', started: 10 * H, at: 11 * H, branches: ['worktree-agent-x'], report: 'committed as `ccccccc`', commits: [] },
        { id: 'merge', started: 12 * H, at: 12.1 * H, branches: [], report: 'main is at `ddddddd`, right after `eeeeeee` and `ccccccc`', commits: [] }
    ];
    const left = nestCommits(agents, [c('c', 10.5 * H, 'worktree-agent-x'), c('d', 12.05 * H, 'main'), c('e', 2 * H, 'main'), c('f', 12.05 * H, 'main')]);
    assert.deepEqual(agents.map(a => [a.id, a.commits.map(x => x.hash[0])]), [['build', ['c']], ['merge', ['d']]], 'branch first, then a hash named in the report while it ran');
    assert.deepEqual(left.map(x => x.hash[0]), ['e', 'f'], 'an older commit the merge agent only refers to stays loose');

    const now = new Date(2026, 10, 13, 12).getTime(), at = (d, h) => new Date(2026, 10, d, h).getTime();
    const days = groupByDay([{ at: at(11, 9) }, { at: at(13, 8) }, { at: at(12, 23) }, { at: at(13, 11) }], now);
    assert.deepEqual(days.map(d => [d.label, d.entries.map(e => new Date(e.at).getHours())]), [['Today', [11, 8]], ['Yesterday', [23]], ['Wednesday 11 Nov', [9]]]);
    assert.deepEqual(groupByDay([], now), []);
    console.log('ok log');
}

// Context % and compacting
{
    const { contextOf, refuseIfBusy } = await import('./server.mjs');
    const { isHumanPrompt } = await import('./server/transcripts.mjs');
    const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ctxLevel, canCompact, autoCompactDue, AUTO_COMPACT } = await import('./public/core.js');

    const dir = mkdtempSync(join(tmpdir(), 'homebase-ctx-')), id = 'bbbbbbbb-0000-4000-8000-000000000001';
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ context_window: { used_percentage: 72.5 } }));
    utimesSync(join(dir, `${id}.json`), 1000, 1000);
    assert.deepEqual(await contextOf(id, dir), { percent: 72.5, at: 1_000_000 });
    assert.equal(await contextOf('bbbbbbbb-0000-4000-8000-000000000002', dir), null, 'no dump yet');
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ context_window: { used_percentage: null } }));
    assert.equal(await contextOf(id, dir), null, 'no percentage');
    writeFileSync(join(dir, `${id}.json`), '{ torn');
    assert.equal(await contextOf(id, dir), null, 'unreadable dump');
    assert.equal(await contextOf('../../etc/passwd', dir), null, 'only session ids name a file');
    rmSync(dir, { recursive: true, force: true });

    assert.throws(() => refuseIfBusy({ status: 'working' }), { status: 409, message: 'busy' });
    assert.throws(() => refuseIfBusy({ status: 'waiting', asking: true }), { status: 409, message: 'busy' });
    assert.doesNotThrow(() => refuseIfBusy({ status: 'waiting', asking: false }));
    assert.doesNotThrow(() => refuseIfBusy({ status: 'idle' }));

    assert.deepEqual([0, 59.9, 60, 84.9, 85, 100].map(ctxLevel), ['', '', 'warn', 'warn', 'hot', 'hot']);
    assert.deepEqual([canCompact({ status: 'idle' }), canCompact({ status: 'waiting' }), canCompact({ status: 'working' }), canCompact({ status: 'waiting', asking: true })], [true, true, false, false]);

    // auto-compact: idle for 2 min, at 70%, not tried within the hour
    const t = 10 * 3600_000, ready = { status: 'idle', context: 70, lastActivity: t - AUTO_COMPACT.idleMs };
    assert.equal(autoCompactDue(ready, t, 0), true);
    assert.equal(autoCompactDue({ ...ready, context: 69.9 }, t, 0), false, 'under the threshold');
    assert.equal(autoCompactDue({ ...ready, context: null }, t, 0), false, 'no context reading');
    assert.equal(autoCompactDue({ ...ready, lastActivity: t - AUTO_COMPACT.idleMs + 1 }, t, 0), false, 'idle under 2 min');
    assert.equal(autoCompactDue({ ...ready, lastActivity: null, updated: t - 60_000 }, t, 0), false, 'falls back to updated');
    assert.equal(autoCompactDue({ ...ready, status: 'working' }, t, 0), false, 'mid-turn');
    assert.equal(autoCompactDue({ ...ready, asking: true }, t, 0), false, 'asking');
    assert.equal(autoCompactDue(ready, t, t - AUTO_COMPACT.everyMs + 1), false, 'tried within the hour');
    assert.equal(autoCompactDue(ready, t, t - AUTO_COMPACT.everyMs), true, 'an hour later');

    // /compact keeps the session id: the boundary shows as a divider, its summary text not at all
    const boundary = { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: '2026-11-09T14:52:22.148Z', compactMetadata: { trigger: 'manual' } };
    const summary = { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } };
    const compacted = chatItems([{ type: 'user', message: { content: 'go' } }, say('Done.'), boundary, summary, say('Carrying on.')]);
    assert.deepEqual(compacted.map(i => [i.role, i.text]), [['user', 'go'], ['assistant', 'Done.'], ['compact', 'Conversation compacted'], ['assistant', 'Carrying on.']]);
    assert.equal(compacted[2].at, boundary.timestamp);
    assert.equal(isHumanPrompt(summary), false, 'the summary is not a prompt');
    console.log('ok context and compact');
}
