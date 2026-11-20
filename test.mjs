import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { status, summarize, column, itemUpdated } from './server.mjs';

assert.equal(column('working', { state: 'merged' }, true), 'doing');
assert.equal(column('idle', { state: 'merged' }, true), 'done');
assert.equal(column('idle', { state: 'open', ready: true }, true), 'ready');
assert.equal(column('idle', { state: 'open', changes: true }, true), 'needs-you');
assert.equal(column('idle', { state: 'open', blocked: 'conflict' }, true), 'needs-you');
assert.equal(column('idle', { state: 'open', blocked: 'checks' }, true), 'review'); // nothing to type for an external check
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
// an agent whose last act was the hand-back call (no result, meta.finished not flipped yet) is done, not running for half an hour
assert.equal(summarizeAgent({ finished: false }, [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Done.' } }] } }], 5 * 60_000).status, 'done');
{
    // a row goes by the newest SendMessage summary sent to that agent
    const { sentSummaries } = await import('./server.mjs');
    const send = (to, summary) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to, summary, message: 'x' } }] } });
    assert.deepEqual([...sentSummaries([send('a1', 'Merge it'), send('a2', 'Docs'), send('a1', 'Also rebase'), send('a2'), { ...send('a2', 'Nested'), isSidechain: true }])],
        [['a1', 'Also rebase'], ['a2', 'Docs']]);
}
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
// a thinking-only entry is mid-reply (a stalled stream is retried after minutes), not a turn that ended
const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: null } };
assert.equal(st([call('a'), result('a'), thinking], 8 * MIN).status, 'running');
assert.equal(st([call('a'), result('a'), thinking], 11 * MIN).status, 'stopped');
assert.deepEqual(st([call('a'), result('a'), { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error' }] } }], 1_000), { status: 'stopped', stopReason: 'api-error' });
// pracsys 5010a555: an agent that dies on "Please run /login · API Error: 403" gets meta.finished too, and the master a "failed" notification
assert.deepEqual(st([call('a'), result('a'), { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'Please run /login · API Error: 403' }] } }], 99 * MIN, { finished: true }), { status: 'stopped', stopReason: 'api-error' });
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
// the other launch forms: a Bash moved to the background by its timeout or by a message, a Monitor, a background Workflow
for (const launch of [
    'Command did not complete within its 600s timeout and was moved to the background (ID: bt9p1x). Output is being written to: /tmp/x',
    'Command was moved to the background (ID: bt9p1x) after running for 180s. Output is being written to: /tmp/x',
    'Command was moved to the background (ID: bt9p1x) so that a message that arrived while it was running can reach you.',
    'Monitor started (task bt9p1x, expires in 20m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch).',
    'Workflow launched in background. Task ID: bt9p1x\nSummary: one review round'
]) {
    const r = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: launch }] } };
    assert.equal(st([call('a'), r, onHold('Waiting for the notification.')], 3 * MIN).status, 'running', launch);
    assert.equal(st([call('a'), r, told('bt9p1x'), ended], 3 * MIN).status, 'stopped', launch);
}
// a timed-out Bash prints its output before the notice
const late = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Feature: EHF\n  1 passed\nCommand was moved to the background (ID: bt9p1x) after running for 180s.' }] } };
assert.equal(st([call('a'), late, ended], 3 * MIN, { finished: true }).status, 'running');
// homebase 5f274065: a finished agent that read a file or grepped a transcript quoting a launch is done, not running for 30 minutes
for (const quoted of ['75\tconst bg = \'Command running in background with ID: b172vb7y2.\'', '{"content":"Command running in background with ID: b172vb7y2. Output"}', '69:Monitor started (task bt9p1x, expires in 20m'])  {
    const r = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: quoted }] } };
    assert.equal(st([call('a'), r, ended], 3 * MIN, { finished: true }).status, 'done', quoted);
}
console.log('ok agents');

import { splitTldr, splitTopic, toolSummary, chatItems, pendingQuestion, sendSteps, RISKY } from './server.mjs';
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
// a subagent's task notification is one line per prompt, however often it re-notifies; background commands stay out
const taskNote = (status, summary) => ({ type: 'user', message: { content: `<task-notification>\n<task-id>x</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>` } });
assert.deepEqual(chatItems([
    { type: 'user', message: { content: 'go' } }, taskNote('completed', 'Agent "Fix login" finished'), say('Fixed.'), taskNote('completed', 'Agent "Fix login" finished'),
    taskNote('failed', 'Agent "Docs" failed'), taskNote('completed', 'Background command "npm test" completed (exit code 0)')
]).map(i => [i.role, i.text]), [['user', 'go'], ['tools', 'Agent finished: Fix login'], ['assistant', 'Fixed.'], ['error', 'Agent failed: Docs']]);
// absorbed mid-turn as a queued_command it is the same line, without starting a new turn; waiting on its own work is no news
const absorbed = (status, summary) => ({ type: 'attachment', attachment: { type: 'queued_command', origin: { kind: 'task-notification' }, prompt: taskNote(status, summary).message.content } });
assert.deepEqual(chatItems([
    { type: 'user', message: { content: 'go' } }, say('On it.'), absorbed('completed', 'Agent "Fix login" is waiting on its own background work'),
    absorbed('completed', 'Agent "Docs" finished'), absorbed('killed', 'Agent "Lint" was stopped by Claude'), taskNote('completed', 'Agent "Fix login" is waiting on its own background work')
]).map(i => [i.role, i.text]), [['user', 'go'], ['assistant', 'On it.'], ['tools', 'Agent finished: Docs'], ['error', 'Agent stopped: Lint']]);
// a push, merge or force gets its own visible line (the pattern the permission card turns red on); other commands stay quiet
const cmdUse = command => tu('Bash', { input: { command } });
assert.deepEqual(chatItems([
    { type: 'user', message: { content: 'ship' } }, cmdUse('npm test'), cmdUse('git push origin main'), cmdUse('git status'),
    cmdUse('glab mr merge 42 \\\n  --squash'), cmdUse('git pushd'), cmdUse('rm -fr build'), cmdUse('git merge-base a b')
]).map(i => [i.role, i.text, i.quiet, i.risky]), [
    ['user', 'ship', undefined, undefined], ['tools', 'Ran 1 command', true, undefined], ['tools', 'Ran: git push origin main', undefined, true],
    ['tools', 'Ran 1 command', true, undefined], ['tools', 'Ran: glab mr merge 42 \\ --squash', undefined, true], ['tools', 'Ran 1 command', true, undefined],
    ['tools', 'Ran: rm -fr build', undefined, true], ['tools', 'Ran 1 command', true, undefined]
]);
assert.ok(['git reset --hard HEAD~1', 'git push -f', 'git push --force-with-lease', 'gh pr merge 3', 'DROP TABLE users', 'kubectl delete pod x', 'rm -Rf /tmp/x'].every(c => RISKY.test(c)));
assert.ok(!['git pull', 'git merge-base a b', 'npm run format', 'rm -r dist', 'git log --format=%H'].some(c => RISKY.test(c)));
const topical = chatItems([{ type: 'user', message: { content: 'go' } }, say('**▸ Topic headers**\n\nDone.\n\n**TLDR:** shipped')]).at(-1);
assert.deepEqual([topical.topic, topical.text, topical.tldr, topical.needsYou], ['Topic headers', 'Done.', 'shipped', false]);
// needs-you: the topic marker, or (no marker) a TLDR ending in "?"
const needy = text => chatItems([{ type: 'user', message: { content: 'go' } }, say(text)]).at(-1);
assert.deepEqual([needy('**▸ Ports · needs you**\n\nX.\n\n**TLDR:** pick one').topic, needy('**▸ Ports · needs you**\n\nX.\n\n**TLDR:** pick one').needsYou], ['Ports', true]);
assert.equal(needy('**▸ Ports**\n\nX.\n\n**TLDR:** **Use 4478?**').needsYou, true);
assert.equal(needy('Is it? Yes.\n\nTLDR: done').needsYou, false);
// ...until the user replies: then it's history, not a question
assert.deepEqual(chatItems([say('**▸ Ports · needs you**\n\nTLDR: pick one'), { type: 'user', message: { content: 'use 4478' } }]).map(i => i.needsYou), [false, undefined]);
assert.equal(chatItems([say('TLDR: Ship it?'), { type: 'user', message: { content: 'yes' } }])[0].needsYou, false); // answered by a chip
{
    // the feed keeps the newest `max` items and says how many are earlier, but never cuts a question still waiting on you
    const { chatFeed } = await import('./server.mjs');
    const turn = { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } };
    const long = [{ type: 'user', message: { content: 'go' } }, say('**▸ Ports · needs you**\n\nPick one.'), ...['a', 'b', 'c'].flatMap(t => [turn, say(t)])];
    const feed = max => { const f = chatFeed(long, max); return [f.items.map(i => i.topic ?? i.text), f.earlier]; };
    assert.deepEqual(feed(2), [['Ports', 'b', 'c'], 2]);
    assert.deepEqual(feed(60), [['go', 'Ports', 'a', 'b', 'c'], 0]);
    assert.deepEqual(chatFeed([...long, { type: 'user', message: { content: 'use 4478' } }], 2).items.map(i => i.text), ['c', 'use 4478']); // answered: cut
}
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
assert.throws(() => refuseIfLiveElsewhere(60_000), { status: 409, message: /outside Homebase/ });
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
// the same text typed twice within a minute is two messages; so is the same text queued twice
const twice = chatItems([
    { type: 'user', message: { content: 'continue' }, timestamp: T('00.000') },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: T('01.000') },
    { type: 'user', message: { content: 'continue' }, timestamp: T('20.000') },
    { type: 'attachment', timestamp: T('30.000'), attachment: { type: 'queued_command', prompt: 'yes', origin: { kind: 'human' } } },
    { type: 'attachment', timestamp: T('31.000'), attachment: { type: 'queued_command', prompt: 'yes', origin: { kind: 'human' } } }
]);
assert.deepEqual(twice.map(i => i.text), ['continue', 'ok', 'continue', 'yes', 'yes']);
// a prompt starting with "<" is the user's; Claude Code's own tagged lines are not
{
    const { isHumanPrompt } = await import('./server/transcripts.mjs');
    const typed = text => ({ type: 'user', message: { content: text }, timestamp: T('40.000') });
    const lines = ['<div> overflows on mobile', `${paste('p', 'pasted')}`, '<task-notification>\n<task-id>x</task-id>', '<command-name>/clear</command-name>', '<bash-input>ls</bash-input>', '<local-command-stdout>ok</local-command-stdout>', '<artifact-content-authored-by-others/> x'];
    assert.deepEqual(lines.map(t => isHumanPrompt(typed(t))), [true, true, false, false, false, false, false]);
    assert.deepEqual(chatItems(lines.map(typed)).map(i => i.text), ['<div> overflows on mobile', 'pasted']);
    assert.deepEqual(queuedPrompts([{ type: 'queue-operation', operation: 'enqueue', content: '<b>bold</b> please', timestamp: T('41.000') }]).map(q => q.text), ['<b>bold</b> please']);
}
console.log('ok pasted + dedupe');
import { nextStep, workItems } from './server.mjs';
const open = extra => ({ state: 'open', reviewers: [], ...extra });
assert.equal(nextStep({ state: 'merged' }, { status: 'running', stage: 1 }), 'Merged');
assert.equal(nextStep(open(), { status: 'running', stage: 2, description: 'Rebase !7' }), 'Rebase !7 is verifying…');
assert.equal(nextStep(open(), { status: 'running', stage: 2, description: 'Rebase !7', step: 'running unit tests' }), 'running unit tests');
{
    const { stepOf } = await import('./server.mjs');
    assert.equal(stepOf({ name: 'Bash', input: { command: 'npm test\nmore' } }), 'running unit tests');
    const { plainCommand } = await import('./public/core.js');
    assert.deepEqual([
        'while pgrep -f "run.mjs" >/dev/null; do sleep 5; done', 'node tests/browser/run.mjs', 'node test.mjs', './check-types.sh', 'git rebase main', 'git push origin x',
        "sed -i '' 's/a/b/' public/app.js", 'cat server/items.mjs', 'rg foo', 'git grep x', 'glab mr list', 'curl -s x', 'until grep -q "passed" /tmp/log; do sleep 2; done',
        'python3 - <<\'EOF\'', 'zsh /private/tmp/x/run-it.sh', 'cd /r && git commit -m x', 'node shot.mjs --screenshot'
    ].map(plainCommand), [
        'waiting for browser tests', 'running browser tests', 'running unit tests', 'type-checking', 'rebasing', 'pushing',
        'editing app.js', 'reading items.mjs', 'searching', 'searching', 'calling GitLab', 'calling an API', 'waiting',
        'running python', 'running run-it.sh', 'committing', 'taking screenshots'
    ]);
    assert.equal(stepOf({ name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } }), 'run the unit tests');
    assert.equal(stepOf({ name: 'Edit', input: { file_path: '/x/src/login.js' } }), 'editing login.js');
    assert.equal(stepOf({ name: 'mcp__x__y', input: {} }), 'using mcp__x__y');
}
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
// a row renamed by SendMessage keeps its spawn description as the tooltip
assert.deepEqual(workItems([{ id: 'm', project: 'p', prs: [], agents: [agent('r', 0, { description: 'Also rebase', firstDescription: 'Fix login' })] }], () => null, 0)
    .map(i => [i.title, i.firstTitle]), [['Also rebase', 'Fix login']]);
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
// a stopped agent retried by a later one with the same description no longer offers Continue on the MR
{
    const review = () => ({ state: 'open', reviewers: ['Ann'], issue: '7', branch: 'b7' });
    const desc = 'Implement #7 confirm';
    const [row] = workItems([{ id: 's', project: 'p', prs: [{ url: mr(70), at: 1 }], agents: [
        agent('dead', 10, { status: 'stopped', stopReason: 'api-error', description: desc }),
        agent('retry', 20, { description: desc })
    ] }], () => review(), 30, new Map());
    assert.equal(row.agentStatus, null);
    assert.equal(row.next, 'Waiting for review by Ann');
}

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

    // pruning: entries the forge hasn't confirmed for 30 days go, open ones too (an MR it can't read any more stays
    // seeded forever otherwise); an open one it still answers for stays
    const old = loadStore(file);
    record(old, [item(mr(3), { state: 'open' }), item(mr(5), { state: 'open' })], 1000);
    record(old, [item(mr(5), null), item(mr(3), { state: 'open' })], 1000 + 31 * DAY);
    assert.deepEqual(Object.keys(old.data.p), [mr(3)]);

    // two Homebase instances on one file keep each other's entries; a pruned one doesn't come back from disk
    rmSync(file);
    const a = loadStore(file), b = loadStore(file);
    record(a, [item(mr(6), { state: 'open' })], 50_000);
    flush(a, 50_000);
    record(b, [item(mr(7), { state: 'open' })], 60_000);
    flush(b, 60_000);
    assert.deepEqual(Object.keys(loadStore(file).data.p).sort(), [mr(6), mr(7)]);
    assert.deepEqual(readdirSync(dir).sort(), ['items.json']);
    record(b, [], 60_000 + 31 * DAY);
    b.writtenAt = 0;
    flush(b, 60_000 + 31 * DAY);
    assert.equal(loadStore(file).data.p, undefined);

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
assert.deepEqual(act(open({ changes: true, reviewers: ['Ann'] }), null), { label: 'Fix & reply', message: `Address the review comments on !4 (${mr(4)}), push, and reply in each thread.` });
// one precedence with nextStep: a stopped agent wins over the MR's own ask, but not over a merged MR; a running pipeline asks nothing
assert.deepEqual([open({ changes: true }), open({ ready: true })].map(p => act(p, { status: 'stopped' }).label), ['Continue', 'Continue']);
assert.equal(nextStep(open({ ready: true }), { status: 'stopped' }), 'Agent stopped — check the chat');
assert.equal(act({ state: 'merged' }, { status: 'stopped' }), null);
assert.equal(act(open({ ci: 'running' }), null), null);
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
    said('2026-11-13T10:03:00Z', txt('The diff is **ready** for the reviewers.')), // a bold ready while the gate runs is no verdict
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
// real phrasings of the verdict
assert.deepEqual(['the verdict is **fix first**, so', 'Verdict was **ready**, with', 'review-gate is **ready**. Merge', '**Review gate verdict: ready.**']
    .map(t => gateRuns([said('t', skill('review-gate', '!4')), said('t', txt(t))])[0]?.verdict), ['fix first', 'ready', 'ready', 'ready']);
// a subagent briefed with review-gate reports through its handback
const handback = said('2026-11-13T12:00:00Z', { type: 'tool_use', name: 'SubagentHandback', input: { message: '**Verdict: ready** — fine\n\n**TLDR:** **ready** for review, open !7.' } });
assert.equal(gateRuns([handback], 'Run review-gate on the branch').at(0).verdict, 'ready');
assert.deepEqual(gateRuns([handback], 'Implement the badge'), []);
// a batch gate over several MRs: each MR gets the verdict its own line names, none when its verdict can't be told apart
{
    const batch = gateRuns([said('2026-11-13T13:00:00Z', { type: 'tool_use', name: 'SubagentHandback', input: { message: '!101 verdict: ready at commit abc1234\n!102 verdict: fix first\n!103 and !104 verdict: fix first\n\nTLDR: one ready.' } })],
        'Review-gate supplier MRs batch A\nRun review-gate on !101, !102, !103 and !104, one after the other.');
    assert.deepEqual([101, 102, 103, 104].map(n => toGate(gateFor(batch, mr(n), null), null)?.verdict), ['ready', 'fix first', undefined, undefined]);
    assert.deepEqual([gateFor(batch, mr(101), null).commit, gateFor(batch, mr(102), null).commit], ['abc1234', null]);
    // verdicts reported one message at a time keep counting
    const later = gateRuns([said('t1', skill('review-gate', '!5 and !6')), said('t2', txt('!5 verdict: **ready**')), said('t3', txt('!6 — Verdict: fix first'))]);
    assert.deepEqual([5, 6].map(n => gateFor(later, mr(n), null)?.verdict), ['ready', 'fix first']);
}
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
// sessions that start waiting on the user: asking, or idle with a needs-you reply; working or a sidechain doesn't count
import { askingEvents } from './public/list.js';
const ss = (id, o = {}) => ({ id, status: 'idle', asking: false, needsYou: false, sidechain: false, ...o });
const aev = (prev, next) => askingEvents(prev, next).map(e => [e.kind, e.session.id]);
assert.deepEqual(aev(undefined, [ss('a', { asking: true })]), []); // first load
assert.deepEqual(aev([ss('a'), ss('b')], [ss('a', { asking: true }), ss('b', { needsYou: true })]), [['asking', 'a'], ['asking', 'b']]);
assert.deepEqual(aev([ss('a', { asking: true })], [ss('a', { asking: true })]), []);
assert.deepEqual(aev([ss('a')], [ss('a', { needsYou: true, status: 'working' }), ss('c', { asking: true, sidechain: true })]), []);
assert.deepEqual(aev([], [ss('n', { needsYou: true })]), [['asking', 'n']]);
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
import { projectCounts } from './public/core.js';
{
    const items = cols => cols.map((column, i) => ({ key: `${column}${i}`, column }));
    const sessions = [
        { id: 'a', project: 'alpha', status: 'idle', needsYou: true, asking: false, items: items(['doing', 'review', 'needs-you', 'done', 'finished']) },
        { id: 'b', project: 'beta', status: 'working', needsYou: true, asking: false, items: items(['ready']) },
        { id: 'c', project: 'beta', status: 'idle', asking: true, sidechain: true },
        { id: 'd', project: 'other', status: 'idle', asking: true }
    ];
    assert.deepEqual(projectCounts(sessions, ['beta', 'alpha', 'gamma']), [
        { project: 'alpha', waiting: 2 } // beta is working and its sidechain's question isn't the user's; gamma has nothing: both left out
    ]);
    assert.deepEqual(projectCounts([], ['alpha']), []);
    console.log('ok project counts');
}
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
// chips stay on an older unanswered question after Claude says more
const sayAt = (text, at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
const noTools = e => chatItems(e).filter(i => i.role !== 'tools');
assert.deepEqual(chatItems([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2')]).map(i => i.replies), [YN, undefined, []]);
// its chip answer carries the question's timestamp: paired to that question and stripped
const earlier = '\n\n(Answering your earlier question from t1: "Ship it?")';
const paired = noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2'), you('Yes' + earlier, 't3')]);
assert.deepEqual(paired.map(i => [i.role, i.answer, i.needsYou, i.replies]), [['assistant', { text: 'Yes', at: 't3' }, false, undefined], ['assistant', undefined, false, []]]);
const two = noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Done.\n\nTLDR: Merge it?', 't2'), you('No' + earlier, 't3')]);
assert.deepEqual(two.map(i => [i.answer?.text, i.replies]), [['No', undefined], [undefined, YN]]); // the right question
// a plain later message still clears the older question
assert.deepEqual(noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2'), you('ok whatever, later', 't3')]).map(i => [i.role, i.needsYou, i.replies]), [['assistant', false, undefined], ['assistant', false, undefined], ['user', undefined, undefined]]);
const ask2 = tu('AskUserQuestion', { id: 'q2', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite' }] }] } });
assert.deepEqual(pendingAsk([ask2]), [{ question: 'Which DB?', options: ['Postgres', 'SQLite'], descriptions: ['x', ''] }]);
assert.equal(pendingAsk([ask2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] } }]), null);
assert.equal(pendingQuestion([tu('AskUserQuestion', { id: 'q3', input: {} })]), 'Claude asked a question.');
// an AskUserQuestion answered in the card answers the message that asked: no needs-you and no stale chips afterwards
const askedDb = [sayAt('**▸ DB · needs you**\n\nTLDR: Which DB?', 't1'), ask2];
const answeredDb = { type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] }, toolUseResult: { answers: { 'Which DB?': 'Postgres' } } };
assert.deepEqual(noTools([...askedDb, answeredDb]).map(i => [i.answer, i.needsYou, i.replies]), [[{ text: 'Postgres', at: 't2' }, false, undefined]]);
assert.deepEqual(noTools([...askedDb, { ...answeredDb, toolUseResult: 'Error', message: { content: [{ ...answeredDb.message.content[0], is_error: true }] } }])[0].answer.text, 'No answer');
assert.equal(noTools([...askedDb])[0].needsYou, true);
console.log('ok ask answers');
import { askList } from './server.mjs';
assert.equal(askList('Two ways.\n\nWhich one?\n\n1. **A** fast\n   but risky\n2. **B** safe\n\nI pick A.'), 'Which one?\n\n1. **A** fast\n   but risky\n2. **B** safe');
assert.equal(askList('Pick one?\n- A\n\n- B'), 'Pick one?\n- A\n\n- B');
assert.equal(askList('Pick:\n- A\n\n- B'), null); // not asked: a list, not a choice
assert.equal(askList('**Option A**: x\n**Option B**: y'), '**Option A**: x\n**Option B**: y');
assert.equal(askList('No list here. Ship it?'), null);
assert.equal(askList('Long intro.\nOptions:\nprose after'), null);
const opts = chatItems([say('**▸ DB · needs you**\n\nChanged things.\n\nWhich DB?\n- Postgres\n- SQLite\n\n**TLDR:** pick one, **Postgres** recommended')]).at(-1);
assert.equal(opts.options, 'Which DB?\n- Postgres\n- SQLite');
assert.equal(chatItems([say('Did:\n- a\n- b\n\nTLDR: done')]).at(-1).options, undefined); // not a question
import { optionLabels } from './server.mjs';
assert.deepEqual(optionLabels('Which?\n\n1. **Postgres** (Recommended) — fast\n   more detail\n2. **SQLite**: simple'), ['Postgres (Recommended)', 'SQLite']);
assert.deepEqual(optionLabels('- Keep it — less work\n- Drop it: cleaner\n  - a sub-point'), ['Keep it', 'Drop it']);
assert.deepEqual(optionLabels('**Option A**: x\n**Option B**: y'), ['Option A', 'Option B']);
{ // the closing In flight list never becomes the chips; an explicit **Options** list does
    const [r] = chatItems([say('**▸ Cache layer**\n\nTwo things block the cache.\n\n**Options**\n1. **Redis** — shared, needs a server\n2. **In-memory** — simplest\n3. **Skip it** — revisit later\n\nI lean Redis.\n\n**In flight**\n- Nothing running\n- Waiting on you: which cache\n\n**TLDR:** Which cache should I build? **Redis** is my pick.')]);
    assert.equal(r.needsYou, true, 'a TLDR with a question mid-line needs you');
    assert.deepEqual(r.replies, ['Redis', 'In-memory', 'Skip it']);
    assert.ok(r.options.startsWith('**Options**') && r.text.includes(r.options) && !r.options.includes('In flight'));
}
import { namedChoices } from './server.mjs';
assert.deepEqual(namedChoices('**Rebased onto main.** Merge it now? Yes or later.'), ['Yes', 'Later']);
assert.deepEqual(namedChoices('Ready to deploy; say **go**'), ['Go']);
assert.deepEqual(namedChoices('Shipped the fix. Nothing else to do.'), []);
{ // a needs-you reply with no ?-options gets chips for the choices its TLDR or Waiting on you names
    const [a] = chatItems([say('Rebased.\n\n**TLDR:** Rebased **!12** onto main. Merge now? Yes or later.')]);
    assert.deepEqual(a.replies, ['Yes', 'Later']);
    const [b] = chatItems([say('Built it.\n\n**In flight**\n- Waiting on you: say go to deploy\n\n**TLDR:** Build is green.')]);
    assert.deepEqual(b.replies, ['Go']);
    assert.deepEqual(chatItems([say('Built it.\n\n**TLDR:** Build is green, say go to deploy when you like')])[0].replies, [], 'not a needs-you reply');
}
{ // a Heads-up line leaves the body for its own field, shown next to the TLDR
    const [h] = chatItems([say('Done.\n\n**Heads-up:** the migration locks the table for a minute.\n\n**TLDR:** Migration is ready.')]);
    assert.equal(h.headsUp, 'the migration locks the table for a minute.');
    assert.equal(h.text, 'Done.');
}
import { waitingOn, waitingAsk } from './server.mjs';
assert.equal(waitingOn('**In flight**\n- Nothing running\n- Waiting on you: which cache'), 'which cache');
assert.equal(waitingOn('**Waiting on you:** merge **!12**'), 'merge **!12**');
assert.equal(waitingOn('**Waiting on you: pick a port**'), 'pick a port');
assert.equal(waitingOn('- Waiting on you — nothing'), null);
assert.equal(waitingOn('- Waiting on you: none, all done'), null);
assert.equal(waitingOn('Waiting on your review is not a line'), null);
{ // an open decision outlives a later message: the newest reply's Waiting on you, with the chips of its list
    const ask = '**▸ Cache layer**\n\n**Options**\n1. **Redis** — shared\n2. **In-memory** — simplest\n\n**In flight**\n- Waiting on you: which cache\n\n**TLDR:** Which cache?';
    const items = chatItems([say(ask), { type: 'user', message: { content: 'also fix the typo in the README' } }, say('Fixed the typo.\n\n**In flight**\n- Nothing running\n- Waiting on you: which cache (Redis or in-memory)\n\n**TLDR:** Typo fixed.')]);
    assert.equal(items.at(-1).waiting, 'which cache (Redis or in-memory)');
    assert.equal(items.at(-1).needsYou, true);
    assert.equal(items[0].needsYou, false, 'the older question itself is replied to');
    const done = chatItems([say(ask), say('Built Redis.\n\n**In flight**\n- Waiting on you: nothing\n\n**TLDR:** Redis cache is in.')]).at(-1);
    assert.equal(done.waiting, undefined);
}
assert.deepEqual(optionLabels('- only one'), []);
assert.deepEqual(optionLabels(Array.from({ length: 7 }, (_, n) => `- item ${n}`).join('\n')), []); // too many to be choices
assert.equal(optionLabels(`- ${'x'.repeat(80)}\n- y`)[0].length, 60);
// a listed choice: one chip per option instead of Yes / No, and clicking one pairs as the answer
const pick = '**▸ DB · needs you**\n\nWhich DB?\n- **Postgres** (Recommended)\n- **SQLite**\n\n**TLDR:** pick one?';
assert.deepEqual(chatItems([say(pick)]).at(-1).replies, ['Postgres (Recommended)', 'SQLite']);
assert.deepEqual(chatItems([say(pick), you('SQLite', 't1')]).map(i => [i.role, i.answer?.text, i.replies]), [['assistant', 'SQLite', undefined]]);
// needs you without a TLDR: the closing ask is what shows folded, not the opening sentence
const noTldr = chatItems([say('**▸ Deploy · needs you**\n\nBuilt it.\n\nThe tests pass.\n\nDeploy to prod now?')]).at(-1);
assert.deepEqual([noTldr.tldr, noTldr.text], ['Deploy to prod now?', 'Built it.\n\nThe tests pass.']);
// no needs-you marker but a closing question with chips: the same, so the question shows next to them
const plainAsk = chatItems([say('Built it.\n\nThe tests pass.\n\nDeploy to prod now?')]).at(-1);
assert.deepEqual([plainAsk.needsYou, plainAsk.tldr, plainAsk.text, plainAsk.replies], [false, 'Deploy to prod now?', 'Built it.\n\nThe tests pass.', ['Yes', 'No']]);
{ // a "what changed" list in a needs-you reply is not a set of choices: no options, no chips from it
    const body = "**▸ !1850 polish done · needs you**\n\nThe polish pass on !1850 (asking before booking items that supplier automation stopped) added tests for three things:\n\n- the duplicate dialog comes first\n- cancelling the dialog skips payment\n- a double click doesn't open a second dialog\n\n**TLDR:** !1850 (confirm stopped items) is polished locally. Tell me what to clarify about #2281 (rule supplier naming) before it's pushed.";
    const [r] = chatItems([say(body)]);
    assert.equal(r.needsYou, true);
    assert.equal(r.options, undefined);
    assert.ok(!r.replies.includes('the duplicate dialog comes first'), `got ${r.replies}`);
}
{ // the Waiting on you line as the rules write it: question, context and one chip per numbered option
    const w = "#2281, naming the rule's supplier in Aktivitetslogg, on «Forhåndsutfylt av regel» and in the voucher timeline — it's implemented and all its tests pass, and you stopped my push question because you wanted to clarify something — what do you want to clarify? — (1) how the supplier name is read: a read-only database lookup when the rule is loaded, so no new column and never out of date (recommended, already built); (2) the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»; (3) something else.";
    assert.deepEqual(waitingAsk(w), {
        question: 'what do you want to clarify?',
        context: "#2281, naming the rule's supplier in Aktivitetslogg, on «Forhåndsutfylt av regel» and in the voucher timeline — it's implemented and all its tests pass, and you stopped my push question because you wanted to clarify something",
        options: [
            { label: 'how the supplier name is read (recommended)', desc: 'a read-only database lookup when the rule is loaded, so no new column and never out of date (recommended, already built)' },
            { label: 'the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»', desc: '' },
            { label: 'something else', desc: '' }
        ]
    });
    assert.deepEqual(waitingAsk('Merge !12? 1. **Yes** — now 2. Later').options.map(o => o.label), ['Yes', 'Later']);
    assert.deepEqual(waitingAsk('which cache — A) Redis — shared, B) in-memory').options.map(o => o.label), ['Redis', 'in-memory']);
    assert.equal(waitingAsk('which cache, Redis or in-memory'), null);
    assert.equal(waitingAsk('merge !1850 (1) only'), null);
    const [r] = chatItems([say(`Built it.\n\n**Waiting on you:** ${w}\n\n**TLDR:** Tell me what to clarify.`)]);
    assert.deepEqual(r.replies, ['how the supplier name is read (recommended)', 'the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»', 'something else']);
    assert.equal(r.ask.question, 'what do you want to clarify?');
    const [a, b] = chatItems([say(`Built it.\n\n**Waiting on you:** ${w}`), { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }, say(`Still waiting.\n\n**Waiting on you:** ${w}`)]);
    assert.deepEqual([a.replies, b.replies.length], [undefined, 3], 'a later Waiting on you takes the older one\'s chips');
}
console.log('ok ask list');
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
import { limitLeft, runOutIn, modelName } from './public/core.js';
import { keepModelSetting } from './server/control.mjs';
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-settings-')), f = join(dir, 'settings.json');
    const nap = async () => {};
    for (const [start, written, expected] of [
        [{ a: 1, model: 'x' }, { a: 1, model: 'fable' }, { a: 1, model: 'x' }],
        [{ a: 1 }, { a: 1, model: 'fable' }, { a: 1 }]
    ]) {
        writeFileSync(f, JSON.stringify(start));
        const restore = await keepModelSetting(f, { nap });
        writeFileSync(f, JSON.stringify({ ...written, b: 2 })); // Claude Code saved the pick (and something else changed)
        assert.equal(await restore(), true);
        assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { ...expected, b: 2 });
    }
    writeFileSync(f, '{"model":"x"}');
    assert.equal(await (await keepModelSetting(f, { waitMs: 500, nap }))(), false); // never changed: left alone
    rmSync(dir, { recursive: true });
}
assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-5-5', 'claude-fable-5-2', '<synthetic>', null].map(modelName), ['Opus', 'Sonnet', 'Haiku', 'Fable', null, null]);
assert.deepEqual(limitLeft({ used: 30, resetsAt: now + 80 * 60_000 }, now), { left: 70, until: '1h20m' });
assert.deepEqual(limitLeft({ used: 37, resetsAt: now + (4 * 1440 + 22 * 60 + 30) * 60_000 }, now), { left: 63, until: '4d22h' });
assert.deepEqual(limitLeft({ used: 30.5, resetsAt: now + 45 * 60_000 }, now), { left: 70, until: '45m' }); // rounds what is left, like Contado
assert.deepEqual(limitLeft({ used: 104, resetsAt: now - 1 }, now), { left: 0, until: '0m' });
assert.deepEqual(limitLeft({ used: 0, resetsAt: now + 2 * 1440 * 60_000 }, now), { left: 100, until: '2d' });
import { limitView } from './public/core.js';
const thu = new Date(2026, 10, 12, 23, 43).getTime(); // local time, so the reset clock reads the same in any zone
assert.deepEqual(limitView(false, { used: 30, resetsAt: thu + 97 * 60_000 }, thu),
    { label: 'Session', left: 70, when: '01:20', text: '70%', tip: '70% left of your 5-hour limit · resets in 1h37m (01:20)' });
assert.deepEqual(limitView(true, { used: 37, resetsAt: new Date(2026, 10, 17, 19, 0).getTime() }, thu),
    { label: 'Week', left: 63, when: 'Tue 19:00', text: '63%', tip: '63% left of your weekly limit · resets in 4d19h (Tue 19:00)' });
assert.equal(limitView(false, { used: 81, resetsAt: thu + 97 * 60_000 }, thu).text, '19% · resets 1h37m'); // countdown inline only under 20%
assert.equal(limitView(false, { used: 80, resetsAt: thu + 97 * 60_000 }, thu).text, '20%');
console.log('ok limit peaks');

import { unpushedOf } from './server/sessions.mjs';
{
    let calls = 0;
    const ahead = n => async () => { calls++; return { stdout: `${n}\n` }; };
    assert.equal(await unpushedOf('/x/a', 1000, ahead(3)), 3);
    assert.equal(await unpushedOf('/x/a', 1000 + 29_000, ahead(9)), 3, 'cached for 30 s');
    assert.equal(await unpushedOf('/x/a', 1000 + 31_000, ahead(9)), 9);
    assert.equal(calls, 2);
    assert.equal(await unpushedOf('/x/b', 1000, async () => { throw new Error('no upstream configured'); }), null, 'no upstream: no count, no throw');
    console.log('ok unpushed');
}

import { repoPath, groupIssues, milestoneOf, activeMilestones, keepMilestone, worksOn, noMilestones, mineView } from './server.mjs';
import { reviewRows } from './server.mjs';
{
    const mr = (iid, o) => ({ iid, state: 'opened', title: `T${iid}`, web_url: `https://gitlab.com/g/p/-/merge_requests/${iid}`, references: { full: `g/p!${iid}` }, author: { username: 'ann', name: 'Ann' }, draft: false, updated_at: `2026-01-0${iid}T00:00:00Z`, ...o });
    const rows = reviewRows([mr(1), mr(2, { author: { username: 'me' } }), mr(3, { draft: true, head_pipeline: { status: 'failed' } }), mr(4, { state: 'merged' })], 'me');
    assert.deepEqual(rows.map(r => r.iid), [3, 1]); // mine and non-open dropped, newest first
    assert.deepEqual([rows[0].draft, rows[0].pipeline?.status, rows[0].project, rows[0].author, rows[1].pipeline], [true, 'failed', 'g/p', 'Ann', null]);
}
{
    // a failed refresh keeps serving the last good list, and each outage logs once
    const { repoPaths } = await import('./server/account.mjs');
    const { reviewRequests } = await import('./server/reviews.mjs');
    const { swr } = await import('./server/forge.mjs');
    repoPaths.set('rv', { host: 'gitlab.rv.test', path: 'g/rv' });
    const hit = { at: Date.now(), value: [{ url: 'u', iid: 1, title: 'Cached review' }], error: new Error('timed out\nmore') };
    swr.set('reviews:gitlab.rv.test', hit);
    const logged = [];
    const error = console.error;
    console.error = m => logged.push(m);
    try {
        assert.deepEqual(reviewRequests().map(r => r.iid), [1]);
        reviewRequests();
        hit.error = null;
        reviewRequests(); // recovered
        hit.error = new Error('502');
        assert.deepEqual(reviewRequests().map(r => r.iid), [1]);
    } finally {
        console.error = error;
        repoPaths.delete('rv');
        swr.delete('reviews:gitlab.rv.test');
    }
    assert.deepEqual(logged, ['reviews: gitlab.rv.test: timed out', 'reviews: gitlab.rv.test: 502']);
}
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
assert.equal(inMilestone(row('u', null), { id: 7 }), true); // no milestone: always shown
assert.equal(inMilestone({ ...row('u', { id: 8, title: 'R' }), column: 'needs-you' }, { id: 7 }), true);
assert.equal(inMilestone({ ...row('u', { id: 8, title: 'R' }), column: 'ready' }, { id: 7 }), true);
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
// "mine" without a known user is an error in the view, not an empty list; it still lists the milestones for the menu
{
    const v = mineView('p', { host: 'gitlab.com', path: 'g/p' }, [], null);
    assert.deepEqual([v.reason, v.selected.id, v.selected.mine, v.selected.groups, v.selected.error], [null, 'mine', true, undefined, 'could not tell who you are on this forge']);
    assert.equal(v.selected.url, 'https://gitlab.com/g/p/-/issues');
}
console.log('ok milestones');

import { excerpt } from './server.mjs';
import { pillLabel } from './public/milestone.js';
import { issueCards, buildLanes, closedBy, chatMessage, shortTitle, owners, emptyText } from './public/issues.js';
import { reviewNote } from './public/list.js';
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
assert.equal(chatStatus({}).text, 'Claude is done'); // nothing pending: no "your turn"
assert.equal(chatStatus({ items: [{ role: 'assistant', text: '', waiting: 'which cache' }, { role: 'user', text: 'also fix the typo' }] }).text, 'Claude needs your answer', 'an open decision outlives a later message');
assert.deepEqual(chatStatus({ stuck: true }), { kind: 'stuck', text: 'No activity for 30 min — Claude may be stuck' });
assert.equal(chatStatus({}, 0, { needsYou: true, subagents: { running: 2, finished: 0 } }).text, 'Claude needs your answer · 2 agents still working');
assert.equal(chatStatus({}, 0, { needsYou: false, subagents: { running: 1, finished: 0 } }).text, 'Claude is done · 1 agent still working');
assert.equal(chatStatus({ error: true, working: true, asking: 'Pick one?' }).kind, 'error'); // a failed poll never reads as idle or stale working
assert.match(chatStatus({ error: true }).text, /reconnecting/);
assert.equal(chatStatus({ working: true, asking: 'Pick one?', items: [] }).kind, 'asking'); // asking wins
const askedAt = new Date(now - 125 * 60_000).toISOString();
assert.equal(chatStatus({ working: true, items: [{ role: 'user', at: askedAt }, { role: 'user', at: new Date(now).toISOString(), pending: true }] }, now).text, 'Claude is working… · 2h5m');
assert.equal(chatStatus({ working: true, items: [] }, now).text, 'Claude is working…');
assert.equal(chatStatus({ working: true, items: [] }, now, { needsYou: false, subagents: { running: 0, finished: 0 }, step: 'running npm test' }).text, 'Claude is working… · running npm test');
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
    assert.equal(state([td('40:00'), prompt('p', '50:00')], hour), 'stuck');
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
    // idle compaction writes a boundary and a summary entry with turnPosition, but no turn_duration: still idle
    const boundary = { type: 'system', subtype: 'compact_boundary', timestamp: at('58:00') };
    const summary = { ...prompt('s', '58:00'), isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'This session is being continued…' } };
    const idleCompacted = [...turn, td('55:43'), boundary, summary, { type: 'system', subtype: 'informational', content: 'Compacted while idle', timestamp: at('58:00') }];
    assert.equal(state(idleCompacted), 'idle');
    // auto-compact mid-turn: the turn goes on
    assert.equal(state([...turn, boundary, summary]), 'working');
    assert.equal(state([...idleCompacted, prompt('n', '59:00')]), 'working');
    // asking: a pending AskUserQuestion
    assert.equal(state([...turn, tool('k', '55:42', 'AskUserQuestion')]), 'asking');
    // no turn markers (older Claude Code): the 10 s mtime heuristic
    const old = [{ type: 'user', timestamp: at('55:20'), message: { content: 'fix it' } }, reply('b', '55:39')];
    assert.deepEqual(turnState(old, 1_000), { state: 'working', since: null });
    assert.equal(state(old, 60_000), 'idle');
    // an open turn with no write for 30 min is stuck, not working; a closed turn is just idle
    assert.deepEqual(turnState(turn, 31 * 60_000), { state: 'stuck', since: null });
    assert.equal(state([...turn, td('55:43')], 31 * 60_000), 'idle');
    // the session list uses it too
    assert.equal(status(turn.at(-1), 5 * 60_000, turnState(turn, 5 * 60_000)), 'working');
    assert.equal(status(turn.at(-1), 5 * 60_000, { state: 'asking' }), 'waiting');
    assert.equal(summarize([...turn, td('55:43')], 1_000).status, 'waiting');
    console.log('ok turn state');
}

import { askMarker, markerAsk } from './server.mjs';
{
    // the late write: an AskUserQuestion sent with background agents lands in the transcript only once answered, so the
    // hook's marker is all that says the session is asking
    const at = s => `2026-11-14T12:${s}.000Z`, now = Date.parse(at('40:00'));
    const ask = { questions: [{ question: 'Merge now?', options: ['Yes', 'No'] }], toolUseId: 'q1', at: at('26:05') };
    const turn = [
        { type: 'user', timestamp: at('25:00'), turnPosition: { promptIndex: 1 }, message: { content: 'go' } },
        { type: 'assistant', timestamp: at('26:00'), message: { content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: {} }] } },
        { type: 'queue-operation', operation: 'enqueue', content: '<task-notification>', timestamp: at('30:00') },
        { type: 'attachment', timestamp: at('31:00'), attachment: { type: 'queued_command', prompt: '<task-notification>' } }
    ];
    assert.equal(turnState(turn, 60_000).state, 'working');
    assert.deepEqual(markerAsk(ask, turn, now), [{ question: 'Merge now?', options: ['Yes', 'No'] }]);
    assert.equal(turnState(turn, 60_000, { ...ask, at: new Date(Date.now() - 60_000).toISOString() }).state, 'asking');
    assert.equal(summarize(turn, 60_000, { ...ask, at: new Date(Date.now() - 60_000).toISOString() }).question, 'Merge now?');
    // over: its answer, a turn end or a new human prompt after the marker; an older one doesn't count
    const result = (id, s) => ({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
    assert.equal(markerAsk(ask, [...turn, result('q1', '41:00')], now), null);
    assert.notEqual(markerAsk(ask, [...turn, result('a1', '41:00')], now), null, 'another tool result doesn\'t answer the question');
    assert.equal(markerAsk(ask, [...turn, { type: 'system', subtype: 'turn_duration', timestamp: at('41:00') }], now), null);
    assert.equal(markerAsk(ask, [...turn, { type: 'user', timestamp: at('41:00'), message: { content: 'never mind' } }], now), null);
    assert.notEqual(markerAsk(ask, [{ type: 'system', subtype: 'turn_duration', timestamp: at('20:00') }, ...turn], now), null);
    // stale after 24 h; nothing to ask, nothing shown
    assert.equal(markerAsk(ask, turn, now + 25 * 3_600_000), null);
    assert.equal(markerAsk({ questions: [], at: ask.at }, turn, now), null);
    assert.equal(markerAsk(null, turn, now), null);
    // a permission prompt: its message is the question, and any later tool result ends it
    const perm = { permission: 'Claude needs your permission to use Bash', at: at('26:05') };
    assert.deepEqual(markerAsk(perm, turn, now), [{ question: perm.permission, options: [] }]);
    assert.equal(markerAsk(perm, [...turn, result('b1', '41:00')], now), null);
    // a pending AskUserQuestion in the transcript wins over the marker
    const inTranscript = { type: 'assistant', timestamp: at('26:00'), message: { content: [{ type: 'tool_use', id: 'q9', name: 'AskUserQuestion', input: { questions: [{ question: 'Real?', options: [] }] } }] } };
    assert.equal(pendingQuestion([...turn, inTranscript], ask), 'Real?');

    // the hook writes and clears the marker that askMarker reads
    const dir = mkdtempSync(join(tmpdir(), 'hb-ask-')), old = process.env.HOMEBASE_DIR;
    process.env.HOMEBASE_DIR = dir;
    const id = '5010a555-e1b1-4472-afa4-c92b1b2f1882';
    const hook = input => execFileSync(process.execPath, ['hooks/asking.mjs'], { input: JSON.stringify({ session_id: id, ...input }), env: { ...process.env, HOMEBASE_DIR: dir } }).toString();
    const file = join(dir, 'asking', `${id}.json`);
    assert.equal(hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: { questions: [{ question: 'Merge now?', header: 'M', options: [{ label: 'Yes', description: 'd' }, { label: 'No' }] }] } }), '');
    const m = await askMarker(id);
    assert.deepEqual([m.questions, m.toolUseId], [[{ question: 'Merge now?', options: ['Yes', 'No'] }], 'q1']);
    assert.ok(Date.now() - Date.parse(m.at) < 60_000);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Agent' }); // a background agent launched in the same message
    assert.ok(readdirSync(join(dir, 'asking')).includes(`${id}.json`), 'another tool finishing keeps the question');
    hook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', agent_id: 'x' });
    assert.ok(readdirSync(join(dir, 'asking')).includes(`${id}.json`), 'a subagent\'s tool never clears');
    hook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
    assert.equal(await askMarker(id), null);
    hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    assert.equal((await askMarker(id)).permission, 'Claude needs your permission to use Bash');
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    assert.equal(await askMarker(id), null, 'the next tool ends a permission prompt');
    for (const ev of ['Stop', 'UserPromptSubmit']) {
        hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'p' });
        hook({ hook_event_name: ev });
        assert.equal(await askMarker(id), null, `${ev} clears`);
    }
    hook({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'idle' });
    assert.equal(await askMarker(id), null);
    // a bad session id or bad input never writes outside the folder and never fails the hook
    assert.equal(hook({ session_id: '../../x', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), '');
    assert.equal(execFileSync(process.execPath, ['hooks/asking.mjs'], { input: 'not json' }).toString(), '');
    assert.deepEqual(readdirSync(dir), ['asking']);
    assert.equal(await askMarker('../../x'), null);
    writeFileSync(file, '{"half');
    assert.equal(await askMarker(id), null, 'a half-written marker is none');
    process.env.HOMEBASE_DIR = old ?? '';
    if (old === undefined) {
        delete process.env.HOMEBASE_DIR;
    }
    rmSync(dir, { recursive: true });
    console.log('ok asking marker');
}

import { findClearedSuccessor, tmuxFor, lastActivity, linkClears } from './server.mjs';
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
{
    // after a server restart the in-memory alias is gone: the registry still shows the successor in the cleared session's tmux
    const ss = [
        { id: '5f274065-old', cwd: '/r', created: 0, needsYou: true },
        { id: 'a0da2e79-new', cwd: '/r', created: 5 },
        { id: 'bbbbbbbb-own', cwd: '/r', created: 6, needsYou: true }
    ];
    const live = new Map([['a0da2e79-new', 'cc-5f274065'], ['bbbbbbbb-own', 'cc-bbbbbbbb']]);
    linkClears(ss, live, new Map());
    assert.equal(ss[1].clearedFrom, '5f274065-old', 'the successor is found again');
    assert.equal(ss[0].needsYou, false, 'a cleared chat no longer needs you: its question went with the clear');
    assert.equal(ss[2].needsYou, true, 'a live chat in its own tmux keeps its question');
    assert.equal(ss[2].clearedFrom, undefined);
    const fresh = [{ id: 'x-old', cwd: '/r', created: 0, needsYou: true }, { id: 'y-new', cwd: '/r', created: 5 }];
    linkClears(fresh, null, new Map([['y-new', { tmux: 'cc-x-old', from: 'x-old' }]]));
    assert.deepEqual([fresh[1].clearedFrom, fresh[0].needsYou], ['x-old', false], 'a Homebase /clear still in memory too');
}
console.log('ok clear');

import { NEW_TMUX, mapNewProjects, startingProjects } from './server.mjs';
{
    for (const ok of ['cc-new-league', 'cc-new-My_repo.v2', 'cc-new-a']) {
        assert.ok(NEW_TMUX.test(ok), ok);
    }
    for (const bad of ['cc-new-', 'cc-abcdef01', 'cc-new-.x', 'cc-new--x', 'cc-new-a b', 'cc-new-a;b', 'x-cc-new-a', 'cc-new-a\nb', '']) {
        assert.ok(!NEW_TMUX.test(bad), JSON.stringify(bad));
    }
    const live = [{ name: 'cc-new-league', path: '/p/league' }, { name: 'cc-new-other', path: '/p/other' }, { name: 'cc-aaaaaaaa', path: '/p/league' }];
    const ss = [{ id: 'bbbbbbbb-1', cwd: '/p/league', created: 5 }, { id: 'cccccccc-2', cwd: '/p/league', created: 9 }, { id: 'dddddddd-3', cwd: '/elsewhere', created: 1 }];
    const map = new Map();
    mapNewProjects(ss, live, map);
    assert.deepEqual([...map], [['bbbbbbbb-1', { tmux: 'cc-new-league' }]], 'the earliest session in the start dir; a different cwd or no match maps nothing');
    mapNewProjects(ss, live, map);
    assert.equal(map.size, 1, 'a tmux that is mapped already is left alone');
    const own = new Map();
    mapNewProjects(ss, [...live, { name: 'cc-bbbbbbbb', path: '/p/league' }], own);
    assert.deepEqual([...own], [['cccccccc-2', { tmux: 'cc-new-league' }]], 'a session with its own tmux is skipped');
    assert.deepEqual(startingProjects(ss, live), [{ tmux: 'cc-new-other', name: 'other', dir: '/p/other' }], 'only a cc-new tmux with no transcript in its folder is starting');
    // Open in an existing folder: its sessions from before the tmux started are not the new chat
    const opened = [{ name: 'cc-new-league', path: '/p/league', created: 7 }];
    const fresh = new Map();
    mapNewProjects(ss, opened, fresh);
    assert.deepEqual([...fresh], [['cccccccc-2', { tmux: 'cc-new-league' }]]);
    assert.deepEqual(startingProjects(ss, [{ ...opened[0], created: 10 }]).map(p => p.tmux), ['cc-new-league'], 'still starting while only older sessions are there');
}
console.log('ok new project tmux');

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

import { keyAction, stepKey, cycleProject } from './public/keys.js';
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
assert.deepEqual(['n', '[', ']'].map(key => keyAction({ key }, null)), ['needs', 'prevProject', 'nextProject']);
assert.equal(cycleProject(['a', 'b', 'c'], 'c', 1), 'a'); // wraps
assert.equal(cycleProject(['a', 'b', 'c'], 'a', -1), 'c');
assert.equal(cycleProject(['a', 'b', 'c'], 'all', 1), 'a');
assert.equal(cycleProject(['a', 'b', 'c'], 'all', -1), 'c');
assert.equal(cycleProject([], 'all', 1), null);
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

import { localHosts, allowedHost, allowedOrigin, tokenOk } from './server.mjs';
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
    // the remote host: exact name only, https (or http) origin, never another ts.net name
    const ts = ['mac.tail1.ts.net'];
    assert.ok(allowedHost('mac.tail1.ts.net', ts));
    assert.ok(!allowedHost('other.tail1.ts.net', ts) && !allowedHost('localhost:4321', ts) && !allowedHost('mac.tail1.ts.net', local));
    assert.ok(allowedOrigin('https://mac.tail1.ts.net', ts, ['https', 'http']));
    assert.ok(!allowedOrigin('https://mac.tail1.ts.net', ts)); // http only by default
    assert.ok(!allowedOrigin('https://evil.ts.net', ts, ['https', 'http']));
}
console.log('ok access checks');

import { remoteFrom, setupPairing, newCode, pair, deviceOf, cookieOf, deviceCookie, pairedDevices, revoke, isRemote, loginOk, isPairedRequest, CODE_TTL_MS, MAX_FAILS, FAIL_WINDOW_MS } from './server.mjs';
{
    // config: exact host, port defaults to PORT + 1, no wildcard or junk
    assert.equal(remoteFrom({}, 4321), null);
    assert.deepEqual(remoteFrom({ remote: { host: 'Mac.Tail1.ts.net' } }, 4321), { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    assert.deepEqual(remoteFrom({ remote: { host: 'mac.tail1.ts.net', port: 5000, login: 'me@x.com' } }, 4321), { host: 'mac.tail1.ts.net', port: 5000, login: 'me@x.com' });
    for (const bad of [{ host: '*.ts.net' }, { host: '' }, {}, { host: 'a b' }, { host: 'mac.ts.net', port: 4321 }, { host: 'mac.ts.net', port: '1' }, { host: 'mac.ts.net', login: 1 }, null]) {
        assert.throws(() => remoteFrom({ remote: bad }, 4321), /remote must be/, JSON.stringify(bad));
    }

    const dir = mkdtempSync(join(tmpdir(), 'homebase-pair-')), file = join(dir, 'devices.json');
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    const t = 1_000_000;
    // no code yet, then a wrong one: 401
    assert.throws(() => pair('123456', 'x', t), e => e.status === 401);
    const { code, expiresAt } = newCode(t);
    assert.match(code, /^\d{6}$/);
    assert.equal(expiresAt, t + CODE_TTL_MS);
    // expired
    assert.throws(() => pair(code, 'Phone', t + CODE_TTL_MS), e => e.status === 401);
    // rate limit: MAX_FAILS wrong tries in a window, then even the right code is refused until the window passes
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    const c2 = newCode(t).code, wrong = c2 === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_FAILS; i++) {
        assert.throws(() => pair(wrong, 'x', t + i), e => e.status === 401);
    }
    assert.throws(() => pair(c2, 'x', t + MAX_FAILS), e => e.status === 429);
    const later = t + MAX_FAILS + FAIL_WINDOW_MS;
    const secret = pair(` ${c2} `, ' My\u0007 phone ', later);
    assert.match(secret, /^[0-9a-f]{64}$/);
    // single use
    assert.throws(() => pair(c2, 'again', later), e => e.status === 401);
    // only the hash is stored
    const stored = readFileSync(file, 'utf8');
    assert.ok(!stored.includes(secret));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const [dev] = pairedDevices();
    assert.deepEqual(Object.keys(dev).sort(), ['created', 'id', 'lastSeen', 'name']);
    assert.equal(dev.name, 'My phone');
    // cookie: parse, flags, lookup, lastSeen
    const cookie = deviceCookie(secret);
    assert.match(cookie, /^homebase_device=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    assert.equal(cookieOf(`a=1; homebase_device=${secret}; b=2`), secret);
    assert.equal(cookieOf('a=1'), null);
    assert.equal(deviceOf(secret, later).id, dev.id);
    assert.equal(deviceOf('f'.repeat(64), later), null);
    assert.equal(deviceOf('nothex', later), null);
    assert.equal(deviceOf(secret, later + 120_000).lastSeen, later + 120_000);
    // survives a restart (re-read from disk)
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: 'me@x.com' });
    assert.equal(pairedDevices()[0].lastSeen, later + 120_000);
    // requests: local ones always pass; remote ones need the login (when set) and a paired cookie
    const req = (localPort, headers = {}) => ({ socket: { localPort }, headers });
    assert.ok(!isRemote(req(4321)) && isRemote(req(4322)));
    assert.ok(isPairedRequest(req(4321)));
    assert.ok(!isPairedRequest(req(4322)));
    assert.ok(!isPairedRequest(req(4322, { cookie: `homebase_device=${secret}` })), 'login missing');
    assert.ok(!loginOk(req(4322, { 'tailscale-user-login': 'evil@x.com' })));
    assert.ok(isPairedRequest(req(4322, { cookie: `homebase_device=${secret}`, 'tailscale-user-login': 'me@x.com' })));
    // revoke
    assert.equal(revoke('nope'), false);
    assert.equal(revoke(dev.id), true);
    assert.deepEqual(pairedDevices(), []);
    assert.ok(!isPairedRequest(req(4322, { cookie: `homebase_device=${secret}`, 'tailscale-user-login': 'me@x.com' })));
    // no remote config: nothing is remote
    setupPairing(file, null);
    assert.ok(!isRemote(req(4322)) && loginOk(req(4322)));
    rmSync(dir, { recursive: true, force: true });
}
console.log('ok pairing');

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

// A stand-in for the code tree whose mtimes the server watches (HOMEBASE_CODE_DIR): tests touch it, never the real files other runs share.
function codeDir(dir = mkdtempSync(join(tmpdir(), 'hb-code-'))) {

    for (const f of ['server.mjs', 'server/rules.mjs', 'public/styles.css']) {
        mkdirSync(join(dir, f, '..'), { recursive: true });
        writeFileSync(join(dir, f), '');
    }

    return dir;
}

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
    async function start(env, config) {
        const port = await freePort(), dir = mkdtempSync(join(tmpdir(), 'homebase-test-'));
        if (config) {
            writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
        }
        const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', import.meta.url).pathname, env: { ...process.env, HOME: dir, PORT: String(port), HOMEBASE_DIR: dir, HOMEBASE_CODE_DIR: codeDir(join(dir, 'code')), HOMEBASE_STATUSLINE_DIR: dir, HOMEBASE_TMUX_SOCKET: 'homebase-test-none', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
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
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-codetool': '1' } })).status, 401);
        // without x-codetool a POST matches no route, even with the token
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-homebase-token': token }, body: 'hi' })).status, 404);
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-homebase-token': token } })).status, 404);
        // only known sessions and plain transcript folders; HOME is empty, so nothing reaches tmux
        const authed = { 'x-homebase-token': token };
        for (const dir of ['..', 'a%2Fb']) {
            assert.deepEqual((({ status, body }) => [status, body])(await call(s.port, { path: `/api/transcript?dir=${dir}&id=x`, headers: authed })), [400, 'bad path'], dir);
        }
        const sent = await call(s.port, { path: '/api/send?id=..%2Fx', method: 'POST', headers: { ...authed, 'x-codetool': '1' }, body: 'hi' });
        assert.deepEqual([sent.status, sent.body], [500, 'bad id']);
        for (const [tmux, want] of [['cc-abcdef01', [400, 'bad tmux name']], ['cc-new-x;y', [400, 'bad tmux name']], ['cc-new-nosuch', [409, "cc-new-nosuch isn't running"]]]) {
            const r = await call(s.port, { path: `/api/send?tmux=${encodeURIComponent(tmux)}`, method: 'POST', headers: { ...authed, 'x-codetool': '1' }, body: 'hi' });
            assert.deepEqual([r.status, r.body], want, tmux);
        }
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

    // Remote access: a second loopback port for tailscale serve; unpaired devices get only the pair page.
    const rport = await freePort(), rhost = 'mac.tail1.ts.net';
    const rs = await start({}, { remote: { host: rhost, port: rport, login: 'me@x.com' } });
    try {
        const remote = (o = {}) => call(rport, { host: rhost, ...o, headers: { 'tailscale-user-login': 'me@x.com', ...o.headers } });
        assert.match(rs.out, new RegExp(`tailscale serve --bg http://127.0.0.1:${rport}`));
        // a forged local Host on the remote port, the remote Host on the local port, a wrong or missing login: refused
        assert.equal((await remote({ host: `localhost:${rport}` })).status, 403);
        assert.equal((await call(rs.port, { host: rhost })).status, 403);
        assert.equal((await remote({ headers: { 'tailscale-user-login': 'evil@x.com' } })).status, 403);
        assert.equal((await call(rport, { host: rhost })).status, 403);
        // unpaired: the pair page, without the token; everything else 401
        const pairHtml = await remote();
        assert.equal(pairHtml.status, 200);
        assert.match(pairHtml.body, /Pair this device/);
        assert.equal(meta(pairHtml.body), undefined);
        assert.equal(pairHtml.headers['cache-control'], 'no-store');
        for (const path of ['/app.js', '/sw.js', '/icon.svg', '/manifest.webmanifest', '/api/limits', '/api/pair/devices', '/api/push/key']) {
            assert.equal((await remote({ path })).status, 401, path);
        }
        // the Mac makes a code; a remote device can't
        const local = meta((await call(rs.port)).body);
        const { code } = JSON.parse((await call(rs.port, { path: '/api/pair/code', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': local } })).body);
        const form = c => ({ path: '/pair', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${rhost}` }, body: `code=${c}&name=Phone` });
        assert.equal((await remote({ ...form(code), headers: { ...form(code).headers, origin: 'https://evil.com' } })).status, 403);
        const bad = await remote(form(code === '000000' ? '000001' : '000000'));
        assert.equal(bad.status, 401);
        assert.match(bad.body, /wrong or has expired/);
        const ok = await remote(form(code));
        assert.equal(ok.status, 303);
        const cookie = ok.headers['set-cookie'][0].split(';')[0];
        assert.match(ok.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Strict/);
        assert.equal((await remote(form(code))).status, 401, 'single use');
        // paired: the app with its token; the API needs the token too; pairing stays Mac-only
        const app = await remote({ headers: { cookie } });
        const token = meta(app.body);
        assert.ok(token);
        assert.equal(token, local);
        assert.equal((await remote({ path: '/api/limits', headers: { cookie } })).status, 401);
        assert.equal((await remote({ path: '/api/limits', headers: { cookie, 'x-homebase-token': token } })).status, 200);
        assert.equal((await remote({ path: '/api/pair/devices', headers: { cookie, 'x-homebase-token': token } })).status, 403);
        // what a paired phone needs for push: the service worker, the icon, and the subscribe route
        const sw = await remote({ path: '/sw.js', headers: { cookie } });
        assert.deepEqual([sw.status, sw.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
        for (const path of ['/icon.svg', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png']) {
            assert.equal((await remote({ path, headers: { cookie } })).status, 200, path);
        }
        const subscribe = { path: '/api/push/unsubscribe', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, origin: `https://${rhost}`, 'content-type': 'application/json' }, body: '{"endpoint":"https://fcm.googleapis.com/x"}' };
        assert.equal((await remote(subscribe)).status, 401, 'unpaired');
        assert.equal((await remote({ ...subscribe, headers: { ...subscribe.headers, cookie } })).status, 200);
        const ua = (await import('node:crypto')).createECDH('prime256v1');
        ua.generateKeys();
        const pushSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
        assert.equal((await remote({ ...subscribe, path: '/api/push/subscribe', headers: { ...subscribe.headers, cookie }, body: JSON.stringify(pushSub) })).status, 200);
        const subsFile = join(rs.dir, 'subscriptions.json');
        assert.equal(JSON.parse(readFileSync(subsFile, 'utf8')).length, 1);
        assert.equal((await remote({ path: '/api/server/reload', method: 'POST', headers: { cookie, 'x-homebase-token': token, 'x-codetool': '1' } })).status, 403, 'a phone cannot reload the server');
        // revoke on the Mac: the device is back to the pair page
        const [dev] = JSON.parse((await call(rs.port, { path: '/api/pair/devices', headers: { 'x-homebase-token': local } })).body);
        assert.equal(dev.name, 'Phone');
        assert.equal((await call(rs.port, { path: `/api/pair/revoke?id=${dev.id}`, method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': local } })).status, 200);
        assert.equal(meta((await remote({ headers: { cookie } })).body), undefined);
        assert.deepEqual(JSON.parse(readFileSync(subsFile, 'utf8')), [], 'revoke drops the device\'s push subscriptions');
    } finally { rs.stop(); }
    console.log('ok remote access');

    // Reload: POST /api/server/reload replaces the server with a fresh process on the same port.
{
    const s = await start({});
    let pid;
    try {
        const token = meta((await call(s.port)).body);
        const v = JSON.parse((await call(s.port, { path: '/api/version', headers: { 'x-homebase-token': token } })).body);
        assert.equal(v.serverStale, false);
        assert.match(v.page, /^[\w-]{12}$/);
        assert.equal((await call(s.port, { path: '/api/server/reload', method: 'POST', headers: { 'x-homebase-token': token } })).status, 404, 'needs x-codetool');
        assert.equal((await call(s.port, { path: '/api/server/reload', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token } })).body, 'ok');
        for (let i = 0; !pid && i < 50; i++) {
            await new Promise(r => setTimeout(r, 200));
            const page = await call(s.port).catch(() => null);
            const fresh = page?.status === 200 && meta(page.body);
            if (fresh && fresh !== token) {
                pid = JSON.parse((await call(s.port, { path: '/api/version', headers: { 'x-homebase-token': fresh } })).body).pid;
            }
        }
        assert.ok(pid && pid !== v.pid, 'a new server answers on the same port');
        assert.match(readFileSync(join(s.dir, 'server.log'), 'utf8'), /Homebase on/);
    } finally {
        if (pid) {
            process.kill(pid);
        }
        s.stop();
    }
    console.log('ok server reload');
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
    // auto-compact mid-turn: the summary entry (turnPosition, isCompactSummary) keeps the turn's prompt
    const compacted = [td('11:00'), ask, tool('12:05'), { type: 'system', subtype: 'compact_boundary', timestamp: at('12:06') }, prompt('12:06', 'This session is being continued…', { isCompactSummary: true }), tool('12:07')];
    assert.deepEqual(turnPrompts(compacted, 1_000).map(p => p.at), [at('12:00')]);
    assert.deepEqual([...spawnPrompts([...compacted, { type: 'assistant', isSidechain: false, timestamp: at('12:08'), message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Agent', input: {} }] } }]).values()], [ask.message.content]);

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
    // a finished agent links a GitHub PR by #N in its description, as a GitLab one by !N
    const ghPr = 'https://github.com/o/r/pull/12';
    assert.deepEqual(['Address comments on #12', 'Address comments on #123', 'Address comments on !12'].map(d => worksOnMr(ag({ status: 'done', description: d }), ghPr, null)), [true, false, false]);
    assert.equal(worksOnMr(ag({ status: 'done', description: 'Rebase !1785' }), url, pr), true);
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

    // pracsys 5010a555: one turn of 236+ lines and over 512 KB; the tail must reach back to its prompt, or the chat
    // shows idle (no turn markers, so the 10 s mtime fallback) while Claude works
    const g = join(mkdtempSync(join(tmpdir(), 'hb-')), 't.jsonl');
    const t = s => `2026-11-13T10:${s}.000Z`;
    const long = [
        { type: 'system', subtype: 'turn_duration', timestamp: t('00:00') },
        { type: 'user', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'run the accountant agents' }, timestamp: t('01:00') },
        ...Array.from({ length: 300 }, (_, i) => i % 2
            ? { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: 'y'.repeat(2_000) }] }, timestamp: t('02:00') }
            : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'z'.repeat(2_000) } }] }, timestamp: t('02:00') })
    ];
    writeFileSync(g, long.map(l => JSON.stringify(l)).join('\n') + '\n');
    assert.deepEqual(turnState(await readTail(g, statSync(g).size), 60_000), { state: 'working', since: Date.parse(t('01:00')) });
    console.log('ok long turn tail');
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
    // pracsys 5010a555: a task notification that was never dequeued nor removed sits ahead; a prompt typed later is
    // dequeued first (notifications wait behind prompts and agent messages), so it isn't left pending once delivered
    const delivered = { ...typed, message: { role: 'user', content: 'Implement #2225' } };
    assert.deepEqual(queuedPrompts([notify, enqueue, dequeue, delivered]), [], 'a prompt outranks an older notification');
    assert.deepEqual(chatItems([notify, enqueue, dequeue, delivered]).map(i => [i.text, !!i.pending]), [['Implement #2225', false]]);
    // a queued multi-line paste counts as queued too
    assert.deepEqual(queuedPrompts([{ ...enqueue, content: '<pasted_content id="a">\nline 1\nline 2\n</pasted_content id="a">' }]).map(q => q.text), ['line 1\nline 2']);
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
    const { ctxLevel, canCompact, autoCompactDue, compactNudgeDue, tokenPercent, AUTO_COMPACT } = await import('./public/core.js');

    const dir = mkdtempSync(join(tmpdir(), 'homebase-ctx-')), id = 'bbbbbbbb-0000-4000-8000-000000000001';
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ context_window: { used_percentage: 72.5 } }));
    utimesSync(join(dir, `${id}.json`), 1000, 1000);
    assert.deepEqual(await contextOf(id, dir), { percent: 72.5, size: null, at: 1_000_000 });
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

    // thresholds are tokens: 150k / 200k of a 1M window, capped at 90% of a small one
    assert.deepEqual([tokenPercent(150_000, {}), tokenPercent(200_000, {}), tokenPercent(200_000, { contextSize: 400_000 }), tokenPercent(200_000, { contextSize: 200_000 })], [15, 20, 50, 90]);
    assert.equal(compactNudgeDue({ context: 15 }), true);
    assert.equal(compactNudgeDue({ context: 14.9 }), false);
    assert.equal(compactNudgeDue({ context: 37, contextSize: 400_000 }), false);
    // auto-compact: idle for 2 min, at 200k tokens, not tried within the hour
    const t = 10 * 3600_000, ready = { status: 'idle', context: 20, lastActivity: t - AUTO_COMPACT.idleMs };
    assert.equal(autoCompactDue(ready, t, 0), true);
    assert.equal(autoCompactDue({ ...ready, context: 19.9 }, t, 0), false, 'under the threshold');
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

{
    const { validName, mergeConfig, createProject, cloneProject, githubProjects, NEW_PROJECT_DEFAULTS } = await import('./server.mjs');
    const { homedir } = await import('node:os');

    // name validation
    for (const n of ['a', 'my-repo', 'a.b_c-1', 'x'.repeat(100)]) {
        assert.equal(validName(n), true, n);
    }
    for (const n of ['', '.hidden', '..', 'a b', 'a/b', '../x', 'x'.repeat(101), 'é', 'a;rm', undefined, 42]) {
        assert.equal(validName(n), false, String(n));
    }

    // config merging
    assert.deepEqual(mergeConfig(undefined), { ...NEW_PROJECT_DEFAULTS, baseDir: `${homedir()}/Projects` });
    assert.deepEqual([NEW_PROJECT_DEFAULTS.owner, NEW_PROJECT_DEFAULTS.keychainService, NEW_PROJECT_DEFAULTS.sshHost], ['', '', 'github.com']);
    const merged = mergeConfig({ newProject: { owner: 'someone', private: false, baseDir: '/tmp/x' } });
    assert.deepEqual([merged.owner, merged.private, merged.baseDir, merged.sshHost], ['someone', false, '/tmp/x', 'github.com']);
    assert.throws(() => mergeConfig({ newProject: { owner: '-oProxyCommand=x' } }), /newProject.owner/);
    assert.throws(() => mergeConfig({ newProject: { private: 'yes' } }), /newProject.private/);

    // defaults: no keychain, owner detected from gh, nobody is "personal"
    {
        const { resolveOwner, tokenFor, accountOf } = await import('./server/account.mjs');
        const d = mergeConfig(undefined), seen = [];
        assert.equal(await tokenFor(d), null);
        assert.equal(await resolveOwner(d, async (f, args) => (seen.push([f, ...args]), { stdout: 'octo\n' })), 'octo');
        assert.deepEqual(seen, [['gh', 'api', 'user', '--jq', '.login']]);
        assert.equal(await resolveOwner({ owner: 'me' }, async () => assert.fail('configured owner needs no gh')), 'me');
        assert.equal(accountOf({ host: 'github.com', path: 'octo/x' }, d), 'work');
    }

    // the step runner, with every command stubbed: no keychain, gh, git or tmux is ever touched
    const TOKEN = 'ghp_SECRET_TOKEN_123';
    const PERSONAL = { owner: 'lommerusk113', keychainService: 'gh-personal', sshHost: 'github-personal' };
    const config = mergeConfig({ newProject: { ...PERSONAL, baseDir: '/base' } });
    const fake = ({ pane = '', failOn, leak } = {}) => {
        const calls = [];
        const exec = async (file, args, opts = {}) => {
            calls.push({ file, args, env: opts.env, timeout: opts.timeout });
            if (file === 'security') {
                return { stdout: `${TOKEN}\n` };
            }
            if (file === failOn) {
                throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { stderr: leak ? `HTTP 403 for token ${TOKEN}\n` : 'HTTP 403: Resource not accessible\n' });
            }
            return { stdout: '' };
        };
        const tm = async args => {
            if (args[0] === 'capture-pane') {
                return { stdout: pane };
            }
            calls.push({ file: 'tmux', args });
            if (failOn === 'tmux') {
                throw new Error('no server');
            }
        };
        return { calls, deps: { config, exec, tmux: tm, exists: () => false, transcripts: async () => ['11111111-2222-3333-4444-555555555555.jsonl'], nap: async () => {}, waitMs: 1000 } };
    };
    const noToken = v => assert.ok(!JSON.stringify(v).includes(TOKEN), 'token must not appear');

    {
        const { calls, deps } = fake();
        const r = await createProject({ name: 'my-repo', description: 'A thing', private: true }, deps);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'git', 'tmux']);
        assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'gh-personal', '-w']);
        assert.deepEqual(calls[1].args, ['repo', 'create', 'lommerusk113/my-repo', '--private', '--description', 'A thing', '--add-readme']);
        assert.equal(calls[1].env.GH_TOKEN, TOKEN);
        assert.equal('GITHUB_TOKEN' in calls[1].env, false, 'work token is removed');
        assert.deepEqual(calls[2].args, ['clone', 'git@github-personal:lommerusk113/my-repo.git', '/base/my-repo']);
        assert.ok(!JSON.stringify(calls[2]).includes(TOKEN) && !JSON.stringify(calls[3]).includes(TOKEN), 'only gh gets the token');
        assert.ok(calls.every(c => c.file === 'tmux' || c.timeout > 0), 'every step has a timeout');
        assert.deepEqual(calls[3].args, ['new-session', '-d', '-s', 'cc-new-my-repo', '-x', '200', '-y', '50', '-c', '/base/my-repo', 'zsh', '-lic', claudeLine()]);
        assert.deepEqual([r.ok, r.sessionId, r.dir, r.steps.map(s => s.state)], [true, '11111111-2222-3333-4444-555555555555', '/base/my-repo', ['done', 'done', 'done']]);
        noToken(r);
    }
    {
        const { calls, deps } = fake();
        const r = await createProject({ name: 'pub', private: false }, { ...deps, transcripts: async () => [] });
        assert.ok(calls[1].args.includes('--public') && !calls[1].args.includes('--description'));
        assert.equal(r.sessionId, null, 'no transcript in time: the chat is still starting');
    }
    {
        const { calls, deps } = fake({ failOn: 'gh', leak: true });
        const e = await createProject({ name: 'x' }, deps).catch(e => e);
        assert.deepEqual([e.status, e.body.steps.map(s => s.state)], [502, ['failed', 'pending', 'pending']]);
        assert.match(e.message, /HTTP 403 for token \[token\]/);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh'], 'nothing further after gh fails');
        assert.ok(!e.message.includes(TOKEN) && !JSON.stringify(e.body).includes(TOKEN));
    }
    {
        const e = await createProject({ name: 'x' }, fake({ failOn: 'git' }).deps).catch(e => e);
        assert.match(e.message, /github\.com\/lommerusk113\/x was created, but cloning to \/base\/x failed, so nothing is cloned/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['done', 'failed', 'pending']);
        noToken(e.body);
    }
    {
        const e = await createProject({ name: 'x' }, fake({ failOn: 'tmux' }).deps).catch(e => e);
        assert.match(e.message, /was created and cloned to \/base\/x, but starting Claude failed/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['done', 'done', 'failed']);
    }
    {
        const { deps } = fake();
        const keychain = await createProject({ name: 'x' }, { ...deps, exec: async () => { throw new Error('item not found'); } }).catch(e => e);
        assert.match(keychain.message, /could not read keychain item "gh-personal"/);
        for (const [body, d, re] of [[{ name: '../x' }, deps, /Invalid name/], [{ name: 'x', description: 'd'.repeat(351) }, deps, /Description/], [{ name: 'x' }, { ...deps, exists: () => true }, /already exists/]]) {
            const e = await createProject(body, d).catch(e => e);
            assert.deepEqual([e.status, re.test(e.message)], [400, true], e.message);
        }
        const both = fake();
        const [a, b] = await Promise.allSettled([createProject({ name: 'dup' }, both.deps), createProject({ name: 'dup' }, both.deps)]);
        assert.deepEqual([a.status, b.reason?.status], ['fulfilled', 409], 'the same name twice at once');
    }

    // cloning one of the owner's repos: gh lists, the name must be in the list, then the shared clone + chat steps
    const LIST = [
        { name: 'old', description: null, isPrivate: false, updatedAt: '2026-01-01T00:00:00Z', isArchived: false },
        { name: 'dead', description: 'x', isPrivate: true, updatedAt: '2026-12-01T00:00:00Z', isArchived: true },
        { name: 'new', description: 'Fresh', isPrivate: true, updatedAt: '2026-11-01T00:00:00Z', isArchived: false }
    ];
    const withList = (o = {}) => {
        const f = fake(o);
        const exec = f.deps.exec;
        f.deps.exec = async (file, args, opts) => file === 'gh' ? (f.calls.push({ file, args, env: opts.env }), { stdout: JSON.stringify(LIST) }) : exec(file, args, opts);
        f.deps.ttl = 0;
        return f;
    };
    {
        const { calls, deps } = withList();
        const l = await githubProjects({ ...deps, exists: p => p === '/base/old' });
        assert.deepEqual(l.map(r => [r.name, r.local]), [['new', false], ['old', true]], 'newest first, archived out, local marked');
        assert.deepEqual(calls[1].args, ['repo', 'list', 'lommerusk113', '--limit', '200', '--json', 'name,description,isPrivate,updatedAt,isArchived']);
        assert.equal(calls[1].env.GH_TOKEN, TOKEN);
        assert.equal('GITHUB_TOKEN' in calls[1].env, false);
        const e = await githubProjects({ ...fake({ failOn: 'gh', leak: true }).deps, ttl: 0 }).catch(e => e);
        assert.deepEqual([e.status, e.message], [502, 'Could not list repos: HTTP 403 for token [token]']);
    }
    {
        const { calls, deps } = withList();
        const r = await cloneProject({ name: 'new' }, deps);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'git', 'tmux']);
        assert.deepEqual(calls[2].args, ['clone', 'git@github-personal:lommerusk113/new.git', '/base/new']);
        assert.deepEqual(calls[3].args.slice(0, 4), ['new-session', '-d', '-s', 'cc-new-new']);
        assert.deepEqual([r.ok, r.repo, r.dir, r.sessionId, r.steps.map(s => [s.id, s.state])], [true, 'lommerusk113/new', '/base/new', '11111111-2222-3333-4444-555555555555', [['clone', 'done'], ['chat', 'done']]]);
        noToken(r);
    }
    {
        const { calls, deps } = withList();
        for (const [name, d, status, re] of [['nope', deps, 404, /no repo named nope/], ['dead', deps, 404, /no repo named dead/], ['../x', deps, 400, /Invalid name/], ['new', { ...deps, exists: () => true }, 400, /already exists/]]) {
            const e = await cloneProject({ name }, d).catch(e => e);
            assert.deepEqual([e.status, re.test(e.message)], [status, true], name);
        }
        assert.ok(!calls.some(c => c.file === 'git' || c.file === 'tmux'), 'nothing cloned or started');
        const e = await cloneProject({ name: 'new' }, withList({ failOn: 'git' }).deps).catch(e => e);
        assert.match(e.message, /^Cloning to \/base\/new failed, so nothing is cloned:/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['failed', 'pending']);
        const t = await cloneProject({ name: 'new' }, withList({ failOn: 'tmux' }).deps).catch(e => e);
        assert.match(t.message, /^Cloned to \/base\/new, but starting Claude failed/);
        assert.deepEqual(t.body.steps.map(s => s.state), ['done', 'failed']);
    }
    console.log('ok new project');
}

{
    // Open: the folder check, then only the start-chat step; real folders in a temp dir, tmux and transcripts stubbed
    const { allowedDir, openProject, localProjects, githubProjects, mergeConfig } = await import('./server.mjs');
    const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, utimesSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hb-open-')));
    const base = join(root, 'base'), outside = join(root, 'outside'), cwd = join(root, 'elsewhere', 'proj');
    for (const d of [join(base, 'app', '.git'), join(base, 'old', '.git'), join(base, 'busy', '.git'), join(base, 'plain'), outside, cwd]) {
        mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(base, 'file.txt'), '');
    symlinkSync(outside, join(base, 'escape'));
    symlinkSync(join(base, 'app'), join(root, 'link-in'));
    const ok = { baseDir: base, cwds: [cwd] };
    const refused = async (dir, status, re, o = ok) => {
        const e = await allowedDir(dir, o).then(() => null, e => e);
        assert.ok(e, `${dir} must be refused`);
        assert.deepEqual([e.status, re.test(e.message)], [status, true], `${dir}: ${e.message}`);
    };
    assert.equal(await allowedDir(join(base, 'app'), ok), join(base, 'app'));
    assert.equal(await allowedDir(join(base, 'plain'), ok), join(base, 'plain'), 'a plain folder is enough');
    assert.equal(await allowedDir(join(base, 'app', '..', 'old'), ok), join(base, 'old'), '".." that stays inside');
    assert.equal(await allowedDir(join(root, 'link-in'), ok), join(base, 'app'), 'a symlink into baseDir is its target');
    assert.equal(await allowedDir(cwd, ok), cwd, 'a known session cwd outside baseDir');
    await refused(join(base, '..', 'outside'), 403, /is not in/);
    await refused(join(base, 'app', '..', '..', 'outside'), 403, /is not in/);
    await refused(join(base, 'escape'), 403, /is not in/, ok); // a symlink in baseDir that points out
    await refused(outside, 403, /is not in/);
    await refused(base, 403, /is not in/, ok); // baseDir itself
    await refused(`${base}-evil`, 400, /is not a folder/);
    mkdirSync(`${base}x`);
    await refused(`${base}x`, 403, /is not in/); // a sibling sharing baseDir's prefix
    await refused(join(cwd, '..'), 403, /is not in/, ok); // a known cwd's parent
    await refused(join(base, 'nope'), 400, /is not a folder/);
    await refused(join(base, 'file.txt'), 400, /is not a folder/);
    for (const d of ['app', '../base/app', '', undefined, 42, `${base}/app\n`]) {
        await refused(d, 400, /absolute folder path|is not a folder/);
    }

    const config = mergeConfig({ newProject: { baseDir: base } });
    const calls = [];
    const deps = {
        config, cwds: async () => [cwd], project: async d => (d.endsWith('proj') ? 'my repo' : 'app'),
        tmux: async args => { calls.push(args); if (args[0] === 'capture-pane') { return { stdout: '' }; } },
        transcripts: (() => { let n = 0; return async () => (n++ ? ['old.jsonl', 'new.jsonl'] : ['old.jsonl']); })(),
        nap: async () => {}, waitMs: 1000, trustMs: 0
    };
    const r = await openProject({ dir: join(base, 'app') }, deps);
    assert.deepEqual(calls[0], ['new-session', '-d', '-s', 'cc-new-app', '-x', '200', '-y', '50', '-c', join(base, 'app'), 'zsh', '-lic', claudeLine()]);
    assert.deepEqual([r.ok, r.name, r.dir, r.tmux, r.sessionId, r.steps.map(s => [s.id, s.state])], [true, 'app', join(base, 'app'), 'cc-new-app', 'new', [['chat', 'done']]], 'an older transcript is not this chat');
    assert.equal((await openProject({ dir: cwd }, { ...deps, transcripts: async () => [] })).tmux, 'cc-new-my-repo', 'the tmux name is made safe');
    calls.length = 0;
    const e = await openProject({ dir: outside }, deps).catch(e => e);
    assert.deepEqual([e.status, calls], [403, []], 'nothing started outside');
    const t = await openProject({ dir: join(base, 'app') }, { ...deps, tmux: async () => { throw new Error('duplicate session: cc-new-app'); } }).catch(e => e);
    assert.deepEqual([t.status, t.message, t.body.steps.map(s => s.state)], [502, `Starting Claude in ${join(base, 'app')} failed: duplicate session: cc-new-app`, ['failed']]);

    // the list: git repos under baseDir, newest .git first, busy ones out
    const at = s => new Date(Date.now() - s * 1000);
    utimesSync(join(base, 'app', '.git'), at(10), at(10));
    utimesSync(join(base, 'old', '.git'), at(5000), at(5000));
    const l = await localProjects({ config, busy: async () => [join(base, 'busy', '.claude', 'worktrees', 'x')] });
    assert.deepEqual(l.map(p => [p.name, p.dir]), [['app', join(base, 'app')], ['old', join(base, 'old')]]);

    // From my GitHub tells the page each repo's folder, so a cloned one can be opened
    const gh = await githubProjects({ config, ttl: 0, exists: d => d === join(base, 'app'), exec: async (f) => ({ stdout: f === 'gh' ? JSON.stringify([{ name: 'app', description: '', isPrivate: true, updatedAt: '2026-01-01T00:00:00Z', isArchived: false }]) : 'me\n' }) });
    assert.deepEqual(gh.map(r => [r.name, r.local, r.dir]), [['app', true, join(base, 'app')]]);
    rmSync(root, { recursive: true, force: true });
    console.log('ok open project');
}

{
    const { accountOf, readToken, ghRun, signedIn, me, repoOfUrl, sameRepo, workItems, mergeConfig } = await import('./server.mjs');
    const personalCfg = { newProject: { owner: 'lommerusk113', keychainService: 'gh-personal', sshHost: 'github-personal' } };
    const cfg = mergeConfig(personalCfg);
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const hbDir = mkdtempSync(join(tmpdir(), 'hb-cfg-'));
    writeFileSync(join(hbDir, 'config.json'), JSON.stringify(personalCfg));
    process.env.HOMEBASE_DIR = hbDir; // ghRun reads the config file
    const TOKEN = 'ghp_PERSONAL_SECRET_456';

    // token selection: the alias host or the configured owner is personal; everything else, GitLab included, stays work
    const pick = (host, path) => accountOf({ host, path }, cfg);
    assert.equal(pick('github-personal', 'someoneelse/thing'), 'personal', 'alias host');
    assert.equal(pick('github.com', 'lommerusk113/tracker'), 'personal', 'owner match');
    assert.equal(pick('github.com', 'LommeruSK113/tracker'), 'personal', 'owner is case-insensitive');
    assert.equal(pick('github.com', 'acme/beta'), 'work');
    assert.equal(pick('gitlab.com', 'lommerusk113/tracker'), 'work', 'GitLab never uses the GitHub token');
    assert.equal(accountOf({ host: 'github.com', path: 'lommerusk113/x' }, null), 'work', 'no valid config: as today');

    // ghRun with stubbed exec: token only for personal repos, GITHUB_TOKEN removed, one keychain read, token scrubbed from errors
    process.env.GITHUB_TOKEN = 'work-token';
    const calls = [];
    const exec = (fail = false) => async (file, args, opts = {}) => {
        calls.push({ file, env: opts.env });
        if (file === 'security') {
            return { stdout: `${TOKEN}\n` };
        }
        if (fail) {
            throw Object.assign(new Error(`Command failed: gh ${args.join(' ')} ${TOKEN}`), { stderr: `bad credentials ${TOKEN}` });
        }
        return { stdout: '{}' };
    };
    // a failed keychain read is not cached, and the call still runs as today with the keychain error up front
    const k = await ghRun({ host: 'github.com', path: 'lommerusk113/other' }, ['api', 'x'], {}, async file => {
        throw new Error(file === 'security' ? 'denied' : 'HTTP 404');
    }).catch(e => e);
    assert.equal(k.message, 'could not read keychain item "gh-personal"; HTTP 404');
    await ghRun({ host: 'github.com', path: 'lommerusk113/tracker' }, ['api', 'user'], {}, exec());
    await ghRun({ host: 'github-personal', path: 'lommerusk113/tracker' }, ['api', 'user'], {}, exec());
    await ghRun({ host: 'github.com', path: 'acme/beta' }, ['api', 'user'], {}, exec());
    assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'gh', 'gh'], 'one keychain read for two personal calls');
    assert.equal(calls[1].env.GH_TOKEN, TOKEN);
    assert.equal('GITHUB_TOKEN' in calls[1].env, false);
    assert.equal(calls[3].env, undefined, 'work repo: env untouched');
    const err = await ghRun({ host: 'github.com', path: 'lommerusk113/tracker' }, ['api', 'x'], {}, exec(true)).catch(e => e);
    assert.ok(!JSON.stringify([err.message, err.stderr]).includes(TOKEN) && err.stderr.includes('[token]'), 'token scrubbed from errors');

    assert.equal(await readToken('svc-y', async () => ({ stdout: '\n' })).catch(e => e.message), 'could not read keychain item "svc-y"');

    // signedIn per account, with real child processes: fake gh and security first on PATH
    const bin = mkdtempSync(join(tmpdir(), 'hb-acct-'));
    const log = join(bin, 'log'), failFlag = join(bin, 'fail');
    writeFileSync(join(bin, 'security'), `#!/bin/sh\necho ${TOKEN}\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "\${GH_TOKEN:-none}|\${GITHUB_TOKEN:-none}" >> "${log}"\n[ -e "${failFlag}" ] && { echo "boom ${TOKEN}" >&2; exit 1; }\n[ "\${GH_TOKEN:-}" = "${TOKEN}" ] && echo '{"login":"lommerusk113"}' || echo '{"login":"worker"}'\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
        const personal = { host: 'github-personal', path: 'lommerusk113/tracker' }, work = { host: 'github.com', path: 'acme/beta' };
        writeFileSync(failFlag, '');
        assert.equal(await signedIn(personal), null, 'a failed lookup is null...');
        assert.equal(await signedIn(work), null);
        assert.equal(me.size, 0, '...and not cached');
        rmSync(failFlag);
        assert.equal((await signedIn(personal)).username, 'lommerusk113');
        assert.equal((await signedIn(work)).username, 'worker', 'work account is its own entry');
        await signedIn(personal);
        await signedIn(work);
        const lines = readFileSync(log, 'utf8').trim().split('\n');
        assert.equal(lines.filter(l => l === `${TOKEN}|none`).length, 2, 'personal: asked again after the failure, then cached');
        assert.equal(lines.filter(l => l === 'none|work-token').length, 2, 'work: env untouched, asked again after the failure, then cached');
    } finally {
        process.env.PATH = path;
        delete process.env.GITHUB_TOKEN;
    }

    // a known repo's alias keeps its account when only the github.com URL is at hand
    const { repoPaths } = await import('./server/account.mjs');
    repoPaths.set('tracker', { host: 'github-personal', path: 'lommerusk113/tracker' });
    assert.deepEqual(repoOfUrl('https://github.com/lommerusk113/tracker/pull/32'), { host: 'github-personal', path: 'lommerusk113/tracker' });
    assert.deepEqual(repoOfUrl('https://gitlab.com/a/b/-/merge_requests/3'), { host: 'gitlab.com', path: 'a/b' });
    repoPaths.delete('tracker');

    // another repo's MR in a session's pr-links or a store never lands under the project
    const url = 'https://github.com/lommerusk113/homebase/pull/2', own = 'https://github.com/lommerusk113/tracker/pull/32';
    assert.equal(sameRepo(url, 'tracker'), false);
    assert.equal(sameRepo(url, 'tracker', 'lommerusk113/tracker'), true, 'the pr-link\'s own prRepository wins');
    assert.equal(sameRepo(own, 'tracker', 'lommerusk113/homebase'), false);
    const items = workItems([{ id: 's', project: 'tracker', prs: [{ url, at: 1 }, { url: own, at: 2 }, { url: 'https://github.com/x/y/pull/1', at: 3, repo: 'lommerusk113/tracker' }], agents: [] }], () => null, 0, new Map());
    assert.deepEqual(items.map(i => i.pr).sort(), [own, 'https://github.com/x/y/pull/1'].sort());

    const { loadStore } = await import('./server/store.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hb-store-'));
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify({ tracker: { [url]: { state: 'open', lastSeen: Date.now() }, [own]: { state: 'open', lastSeen: Date.now() } } }));
    const st = loadStore(file);
    assert.deepEqual(Object.keys(st.data.tracker), [own], 'the misfiled entry is dropped on load');
    assert.equal(st.dirty, true);
    console.log('ok accounts and repo filtering');
}

// fake glab first on PATH for the forge tests below; each test passes the script body it needs
const fakeBin = mkdtempSync(join(tmpdir(), 'hb-forge-'));
const withFakeGlab = async (body, fn) => {
    writeFileSync(join(fakeBin, 'glab'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${fakeBin}:${path}`;
    try {
        return await fn();
    } finally {
        process.env.PATH = path;
    }
};

import { prState, prs } from './server/forge.mjs';
{
    // a hung glab can't hold the first /api/sessions load: the MR lookup times out like every other forge call
    process.env.HOMEBASE_API_TIMEOUT_MS = '300';
    const t0 = Date.now();
    const value = await withFakeGlab('sleep 5', () => prState('https://gitlab.example.com/g/hung/-/merge_requests/1'));
    assert.equal(value, null);
    assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms`);
    delete process.env.HOMEBASE_API_TIMEOUT_MS;
    console.log('ok fetchPr timeout');
}

// a GitLab MR as glab answers it; fields not given are the plain open, unblocked defaults
const glabMr = (fields, n) => withFakeGlab(`echo '${JSON.stringify({ state: 'opened', title: 't', source_branch: 'b', detailed_merge_status: 'mergeable', ...fields })}'`,
    () => prState(`https://gitlab.example.com/g/p/-/merge_requests/${n}`));
{
    // ready means merge now: a failing or running pipeline GitLab doesn't require still blocks it
    const failed = await glabMr({ head_pipeline: { status: 'failed' } }, 101);
    assert.deepEqual([failed.ready, failed.ci], [false, 'failing']);
    assert.equal(column('idle', failed, true), 'needs-you'); // Fix pipeline is on you
    assert.equal((await glabMr({ head_pipeline: { status: 'running' } }, 102)).ready, false);
    assert.equal((await glabMr({ head_pipeline: { status: 'success' } }, 103)).ready, true);
    console.log('ok ready vs ci');

    // merge statuses besides review and CI say what blocks the MR instead of "Waiting for review"
    const conflict = await glabMr({ detailed_merge_status: 'conflict', reviewers: [{ name: 'Ann' }] }, 111);
    assert.deepEqual([conflict.ready, conflict.blocked, nextStep(conflict, null), rowAction(mr(4), conflict, null, 'T').label], [false, 'conflict', 'Merge conflicts — rebase it', 'Rebase']);
    assert.equal(nextStep(await glabMr({ detailed_merge_status: 'blocked_status' }, 112), null), 'Blocked by another MR');
    // a must-pass project without a pipeline isn't "Pipeline failing"
    assert.equal((await glabMr({ detailed_merge_status: 'ci_must_pass' }, 113)).ci, null);
    // unchecked/checking keep the last answer, so a ready MR doesn't flap and notify again
    const url = 'https://gitlab.example.com/g/p/-/merge_requests/114';
    prs.delete(url);
    assert.equal((await glabMr({}, 114)).ready, true);
    prs.get(url).at = 0;
    const checking = await glabMr({ detailed_merge_status: 'checking' }, 114);
    await prs.get(url).pending;
    assert.equal(prs.get(url).value.ready, true, `checking kept ready (first answer ${checking.ready})`);
    console.log('ok gitlab merge statuses');
}

{
    // a merged MR is not asked again every minute
    const url = 'https://gitlab.example.com/g/p/-/merge_requests/121', calls = join(fakeBin, 'calls');
    prs.set(url, { at: 1, value: { state: 'merged' } });
    await withFakeGlab(`echo x >> "${calls}"; exit 1`, () => prState(url));
    assert.equal(statSync(calls, { throwIfNoEntry: false }), undefined);

    // transcripts that aged out of the listing leave the tail and usage caches
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir = join(home, '.claude', 'projects', 'p'), subs = join(dir, 's1', 'subagents');
    mkdirSync(subs, { recursive: true });
    const line = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hi' }, timestamp: new Date().toISOString() }) + '\n';
    writeFileSync(join(dir, 's1.jsonl'), line);
    writeFileSync(join(subs, 'a1.jsonl'), line);
    writeFileSync(join(subs, 'a1.meta.json'), JSON.stringify({ description: 'a', finished: true }));
    const code = `import { sessions } from './server/sessions.mjs'; import { cache, usageCache } from './server/transcripts.mjs';
        await sessions(); const before = [cache.size, usageCache.size];
        const real = Date.now; Date.now = () => real() + 5 * 864e5; // five days later
        await sessions(); console.log(JSON.stringify([before, [cache.size, usageCache.size]]));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, cwd: import.meta.dirname, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), [[2, 1], [0, 0]]);
    rmSync(home, { recursive: true, force: true });
    console.log('ok caches age out');
}

{
    // a failing MR lookup says why on the row instead of "Open the MR to check its state"
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString(), url = 'https://gitlab.example.com/g/p/-/merge_requests/9';
    writeFileSync(join(dir, 's1.jsonl'), [{ type: 'user', sessionId: 's1', cwd: join(home, 'p'), message: { content: 'hi' }, timestamp: at }, { type: 'pr-link', prUrl: url, timestamp: at }].map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(fakeBin, 'glab'), '#!/bin/sh\necho "glab: 404 Not Found" >&2\nexit 1\n', { mode: 0o755 });
    const code = "import { sessions } from './server/sessions.mjs'; console.log(JSON.stringify((await sessions()).flatMap(s => s.items.map(i => [i.next, i.forgeError]))));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` }, cwd: import.meta.dirname, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), [["Couldn't check the MR: glab: 404 Not Found", 'glab: 404 Not Found']]);
    rmSync(home, { recursive: true, force: true });
    console.log('ok forge error shown');

    // a failing comment fetch is flagged too, so a row without its review threads doesn't look clean
    const home2 = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir2 = join(home2, '.claude', 'projects', 'p');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 's1.jsonl'), [{ type: 'user', sessionId: 's1', cwd: join(home2, 'p'), message: { content: 'hi' }, timestamp: at }, { type: 'pr-link', prUrl: url, timestamp: at }].map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(fakeBin, 'glab'), `#!/bin/sh\ncase "$2" in\n*discussions*) echo "glab: 403 Forbidden" >&2; exit 1;;\n*user) echo '{"username":"me"}';;\n*) echo '${JSON.stringify({ state: 'opened', title: 't', source_branch: 'b', detailed_merge_status: 'not_approved' })}';;\nesac\n`, { mode: 0o755 });
    const code2 = "import { sessions } from './server/sessions.mjs'; await sessions(); await new Promise(r => setTimeout(r, 1500)); console.log(JSON.stringify((await sessions()).flatMap(s => s.items.map(i => i.forgeError))));";
    const out2 = execFileSync(process.execPath, ['--input-type=module', '-e', code2], { env: { ...process.env, HOME: home2, PATH: `${fakeBin}:${process.env.PATH}` }, cwd: import.meta.dirname, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out2.trim().split('\n').at(-1)), ['comments: glab: 403 Forbidden']);
    rmSync(home2, { recursive: true, force: true });
    console.log('ok comment error shown');
}

import { liveSessions, closedSession } from './server/transcripts.mjs';
{
    // the process registry: live pids' session ids; a dead pid's or a half-written entry doesn't count; no registry is null
    const dir = mkdtempSync(join(tmpdir(), 'hb-reg-'));
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(r => dead.on('exit', r));
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'up' }));
    writeFileSync(join(dir, `${dead.pid}.json`), JSON.stringify({ pid: dead.pid, sessionId: 'down' }));
    writeFileSync(join(dir, '1.json'), '{"pid": 1, "sessi');
    writeFileSync(join(dir, `${process.pid}.abc.key`), 'x');
    assert.deepEqual([...(await liveSessions(dir)).keys()], ['up']);
    // its "tmux" field names the tmux session (pane suffix dropped); two live processes in different places -> null
    writeFileSync(join(dir, '2.json'), JSON.stringify({ pid: process.pid, sessionId: 'cleared', tmux: 'cc-35ed361f:@1.%1' }));
    writeFileSync(join(dir, '3.json'), JSON.stringify({ pid: process.pid, sessionId: 'twice', tmux: 'cc-aaaaaaaa:@1.%1' }));
    writeFileSync(join(dir, '4.json'), JSON.stringify({ pid: process.pid, sessionId: 'twice' }));
    assert.deepEqual(Object.fromEntries(await liveSessions(dir)), { up: null, cleared: 'cc-35ed361f', twice: null });
    // the same id in two of Homebase's own tmux sessions: the newest process wins, the older is listed in twice
    writeFileSync(join(dir, '5.json'), JSON.stringify({ pid: process.pid, sessionId: 'dup', tmux: 'cc-e9c15e3f:@3.%3', startedAt: 2000 }));
    writeFileSync(join(dir, '6.json'), JSON.stringify({ pid: process.pid, sessionId: 'dup', tmux: 'cc-f67f8760:@2.%2', startedAt: 1000 }));
    let dupReg = await liveSessions(dir);
    assert.equal(dupReg.get('dup'), 'cc-e9c15e3f');
    assert.deepEqual(dupReg.twice.get('dup'), ['cc-f67f8760']);
    assert.equal(dupReg.started.get('dup'), 2000);
    assert.ok(!dupReg.twice.has('twice'), 'one of them outside our tmux is still elsewhere');
    assert.equal(await liveSessions(join(dir, 'nope')), null);
    rmSync(dir, { recursive: true });

    // a CLI session no live process holds was closed mid-turn: idle at once instead of working for 30 minutes
    const at = s => `2026-11-13T09:${s}.000Z`;
    const turn = [
        { type: 'user', sessionId: 's', entrypoint: 'cli', uuid: 'p', timestamp: at('55:20'), origin: { kind: 'human' }, promptSource: 'typed', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'fix it' } },
        { type: 'assistant', sessionId: 's', entrypoint: 'cli', uuid: 'a', timestamp: at('55:30'), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }], stop_reason: 'tool_use' } }
    ];
    assert.equal(turnState(turn, 60_000).state, 'working');
    assert.equal(turnState(turn, 60_000, null, new Set(['s'])).state, 'working');
    assert.equal(turnState(turn, 60_000, null, new Set(['other'])).state, 'idle');
    assert.equal(turnState(turn, 5_000, null, new Set()).state, 'working', 'a fresh write still counts');
    assert.equal(closedSession(turn.map(e => ({ ...e, entrypoint: 'sdk-cli' })), 60_000, new Set()), false, 'only interactive CLI sessions register');
    console.log('ok closed session');

    // a live process the registry calls busy is working past the stale limit, not stuck; idle or unknown is still stuck
    const old = 31 * 60_000;
    const busy = Object.assign(new Set(['s']), { busy: new Set(['s']) });
    assert.equal(turnState(turn, old, null, new Set(['s'])).state, 'stuck');
    assert.equal(turnState(turn, old, null, busy).state, 'working');
    assert.equal(turnState(turn, old, null, Object.assign(new Set(['s']), { busy: new Set() })).state, 'stuck');
    const reg = mkdtempSync(join(tmpdir(), 'hb-reg-'));
    writeFileSync(join(reg, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 's', status: 'busy' }));
    assert.deepEqual([...(await liveSessions(reg)).busy], ['s']);
    rmSync(reg, { recursive: true });

    // known: false when assistant turns carry no turn markers; true with markers or before any reply
    assert.equal(summarize(turn, 60_000).known, true);
    assert.equal(summarize(turn.map(({ turnPosition, ...e }) => e), 60_000).known, false);
    assert.equal(summarize(turn.slice(0, 1).map(({ turnPosition, ...e }) => e), 60_000).known, true);
    console.log('ok busy not stuck, known flag');
}

import { transcript } from './server/transcripts.mjs';
{
    // /api/transcript without dir or id, or with a path out of the projects folder, is a 400, not a 500
    for (const [dir, id] of [[null, 'x'], ['p', null], ['..', 'x'], ['a/b', 'x']]) {
        assert.equal((await transcript(dir, id).catch(e => e)).status, 400, `${dir} ${id}`);
    }
    console.log('ok transcript bad path');
}

import { parseDialog, selectSteps, trustFolder, trustNewProject, answerStartup } from './server.mjs';
{
    const trust = sel => `
 Accessing workspace:

 /base/league

 Quick safety check: Is this a project you created or one you trust? (Like your
 own code, a well-known open source project, or work from your team). If not,
 take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${sel ? '  No, exit' : '❯ No, exit'}
 ${sel ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder'}

 Enter to confirm · Esc to cancel
`;
    for (const sel of [0, 1]) {
        const d = parseDialog(trust(sel));
        assert.deepEqual(d.options, ['No, exit', 'Yes, I trust this folder']);
        assert.equal(d.selected, sel);
        assert.match(d.question, /^Quick safety check: Is this a project you created or one you trust\?/);
    }
    // a running chat: the user's echoed prompt starts with ❯ too; the dialog is the last ❯ above the hint
    assert.deepEqual(parseDialog(`❯ Please look at the\n  league table\n────\n${trust(1)}`).options, ['No, exit', 'Yes, I trust this folder']);
    assert.equal(parseDialog('some output\n❯ ls\nEnter to confirm'), null, 'a shell prompt is not a dialog');
    assert.equal(parseDialog(trust(0).replace('Enter to confirm', '')), null, 'needs the confirm hint');

    assert.deepEqual(selectSteps('cc-new-x', 0, 1), [['send-keys', '-t', '=cc-new-x:', 'Down'], ['send-keys', '-t', '=cc-new-x:', 'Enter']]);
    assert.deepEqual(selectSteps('cc-new-x', 2, 0), [['send-keys', '-t', '=cc-new-x:', 'Up', 'Up'], ['send-keys', '-t', '=cc-new-x:', 'Enter']]);
    assert.deepEqual(selectSteps('cc-new-x', 1, 1), [['send-keys', '-t', '=cc-new-x:', 'Enter']]);

    // answering: arrows then Enter, only for the exact label, only cc-* sessions; still showing -> error
    const run = async (panes, index, label, name = 'cc-new-league') => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void sent.push(a));
        const err = await answerStartup(name, index, label, { tm, nap: async () => {} }).then(() => null, e => e);

        return { sent, err };
    };
    let r = await run([trust(0), trust(1), 'claude is starting'], 1, 'Yes, I trust this folder');
    assert.equal(r.err, null);
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down'], ['Enter']]);
    r = await run([trust(0), trust(0), trust(1), 'claude is starting'], 1, 'Yes, I trust this folder');
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down'], ['Down'], ['Enter']], 'a dropped arrow is resent');
    r = await run([trust(0)], 1, 'Yes, I trust this folder');
    assert.equal(r.err.status, 502, 'arrows never land');
    assert.ok(!r.sent.some(a => a.includes('Enter')), 'never confirms the default');
    r = await run([trust(0), trust(1)], 1, 'Yes, I trust this folder');
    assert.equal(r.err.status, 502, 'dialog still up');
    r = await run([trust(0)], 1, 'No, exit');
    assert.equal(r.err.status, 409, 'label mismatch');
    assert.deepEqual(r.sent, []);
    assert.equal((await run([trust(0)], 0, 'No, exit', 'zsh')).err.status, 400, 'not a cc-* session');

    // New project auto-trust: only the exact cloned folder
    assert.equal(trustFolder(trust(0)), '/base/league');
    assert.equal(trustFolder(' Accessing workspace:\n\n /base/a-very-long-\n folder/league\n\n Quick safety check'), '/base/a-very-long-folder/league', 'wrapped path');
    assert.equal(trustFolder(' Accessing workspace:\n /base/league\n Quick safety check: Is this'), '/base/league', 'no blank lines');
    for (const [dir, answered] of [['/base/league', true], ['/base', false], ['/base/league2', false], ['/base/leagu', false]]) {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: sent.some(k => k.includes('Enter')) ? 'ok' : sent.length ? trust(1) : trust(0) } : void sent.push(a));
        assert.equal(await trustNewProject('cc-new-league', dir, { tm, nap: async () => {}, waitMs: 1000 }), answered, dir);
        assert.equal(sent.length > 0, answered, `${dir} keys`);
    }
    const none = [];
    assert.equal(await trustNewProject('cc-new-league', '/base/league', { tm: async a => (none.push(a), { stdout: 'loading' }), nap: async () => {}, waitMs: 1000 }), false);
    assert.ok(none.every(a => a[0] === 'capture-pane'), 'no dialog: nothing is sent');
    const { refuseIfTrustDialog } = await import('./server/startup.mjs');
    assert.equal((await refuseIfTrustDialog('cc-new-league', { tm: async () => ({ stdout: trust(0) }) }).catch(e => e)).status, 409, 'send refused while trust dialog is up');
    assert.equal(await refuseIfTrustDialog('cc-new-league', { tm: async () => ({ stdout: '❯ pick\nEnter to select' }) }), undefined, 'other dialogs (questions) still take sends');
    console.log('ok startup dialog');
}

// Restart chat: stubbed tmux, nothing real is touched
{
    const { restartChat, promptUp } = await import('./server.mjs');
    const sid = 'cccccccc-0000-4000-8000-000000000001', session = { id: sid, cwd: '/tmp', status: 'idle' };
    const fake = (live = true, pane = '╭──╮\n│ > │\n') => {
        const calls = [];
        const tm = async a => {
            calls.push(a);
            if (a[0] === 'has-session' && !live) {
                throw new Error('no session');
            }
            return { stdout: a[0] === 'capture-pane' ? pane : '' };
        };
        return { calls, opts: { tm, nap: async () => {}, session } };
    };
    const busy = fake();
    assert.equal((await restartChat(sid, { ...busy.opts, session: { ...session, status: 'working' } }).catch(e => e)).status, 409);
    assert.equal((await restartChat(sid, { ...busy.opts, session: { ...session, asking: true } }).catch(e => e)).message, 'busy');
    assert.deepEqual(busy.calls, [], 'busy: tmux untouched');
    const gone = fake(false);
    assert.deepEqual([(await restartChat(sid, gone.opts).catch(e => e)).status, gone.calls.map(c => c[0])], [409, ['has-session']], 'not ours: nothing killed');
    const ok = fake();
    assert.equal(await restartChat(sid, ok.opts), 'cc-cccccccc');
    assert.deepEqual(ok.calls.map(c => c[0]), ['has-session', 'kill-session', 'new-session', 'capture-pane'], 'kill, then new, then wait for the prompt');
    assert.ok(ok.calls[2].join(' ').includes(`--resume ${sid}`));
    const stuck = fake(true, 'loading');
    assert.equal((await restartChat(sid, { ...stuck.opts, waitMs: 1000 }).catch(e => e)).status, 504);
    assert.deepEqual([promptUp('❯ '), promptUp('loading'), promptUp('Do you trust?\n\n❯ 1. Yes\n  2. No\nEnter to confirm')], [true, false, false]);
    console.log('ok restart chat');
}

// Send: stubbed tmux and registry, nothing real is touched
{
    const { send, withLock, tmuxFor, runningTwice, restartChat } = await import('./server.mjs');
    const sid = 'dddddddd-0000-4000-8000-000000000001', session = { id: sid, cwd: '/tmp', updated: 0 };
    const q = '│ Which one?\n❯ 1. Red\n  2. Blue\nEnter to select · Esc to cancel\n';
    // tmux: live = names has-session finds; panes(calls) = what capture-pane shows
    const fake = ({ live = ['cc-dddddddd'], panes = () => '❯ ' } = {}) => {
        const calls = [];
        const tm = async a => {
            calls.push(a);
            if (a[0] === 'has-session' && !live.includes(a[2].slice(1))) {
                throw new Error('no session');
            }
            return { stdout: a[0] === 'capture-pane' ? panes(calls) : '' };
        };
        return { calls, keys: () => calls.filter(c => c[0] !== 'capture-pane'), opts: reg => ({ tm, nap: async () => {}, reg: async () => reg, waitMs: 2000 }) };
    };
    const typed = (name, text) => [['send-keys', '-t', name, '-l', '--', text], ['send-keys', '-t', name, 'Enter']];

    // registry first: after a server restart (no alias) a /clear'd session is found in its old tmux
    assert.equal(tmuxFor(sid, new Map(), new Map([[sid, 'cc-aaaaaaaa']])), 'cc-aaaaaaaa');
    assert.equal(tmuxFor(sid, new Map(), new Map([[sid, 'main']])), 'cc-dddddddd', 'a non cc-* tmux is not ours');
    let f = fake({ live: ['cc-aaaaaaaa'] });
    assert.equal(await send(sid, 'hi', session, f.opts(new Map([[sid, 'cc-aaaaaaaa']]))), 'cc-aaaaaaaa');
    assert.deepEqual(f.keys(), [['has-session', '-t', '=cc-aaaaaaaa'], ...typed('cc-aaaaaaaa', 'hi')]);
    // live outside a cc-* tmux, or in one this tmux server lacks: refused, nothing started
    for (const t of [null, 'main', 'cc-gone']) {
        f = fake();
        assert.equal((await send(sid, 'hi', session, f.opts(new Map([[sid, t]]))).catch(e => e)).status, 409, String(t));
        assert.ok(!f.calls.some(c => c[0] === 'new-session' || c[0] === 'send-keys'), String(t));
    }
    // live in two of our tmux sessions (registry already picked the newest): sent there, and runningTwice says which to close
    f = fake({ live: ['cc-e9c15e3f', 'cc-f67f8760'] });
    const dup = Object.assign(new Map([[sid, 'cc-e9c15e3f']]), { twice: new Map([[sid, ['cc-f67f8760']]]) });
    assert.equal(await send(sid, 'hi', session, f.opts(dup)), 'cc-e9c15e3f');
    assert.match(await runningTwice(sid, async () => dup), /running twice.*cc-f67f8760/);
    assert.equal(await runningTwice(sid, async () => new Map([[sid, 'cc-e9c15e3f']])), null);
    assert.equal(await runningTwice(sid, async () => null), null);
    // a real other terminal says what to do
    f = fake();
    assert.match((await send(sid, 'hi', session, f.opts(new Map([[sid, 'main']]))).catch(e => e)).message, /outside Homebase.*\/exit/);
    // registry says not live: a fresh transcript write doesn't refuse; the new Claude's prompt is awaited before typing
    const fresh = { ...session, updated: Date.now() };
    f = fake({ live: [], panes: calls => (calls.filter(c => c[0] === 'capture-pane').length < 3 ? 'loading' : '❯ ') });
    assert.equal(await send(sid, 'hi', fresh, f.opts(new Map())), 'cc-dddddddd');
    assert.deepEqual(f.calls.map(c => c[0]).slice(0, 5), ['has-session', 'new-session', 'capture-pane', 'capture-pane', 'capture-pane']);
    assert.deepEqual(f.keys().slice(-2), typed('cc-dddddddd', 'hi'));
    // /clear'd after a server restart: its cc-<id8> tmux now runs another chat, which must never get its keys (nor be restarted)
    const cleared = new Map([['eeeeeeee-0000-4000-8000-000000000002', 'cc-dddddddd']]);
    f = fake();
    const refused = await send(sid, 'hi', session, f.opts(cleared)).catch(e => e);
    assert.deepEqual([refused.status, refused.message], [409, 'This chat was cleared and continues as another chat — open that one']);
    assert.ok(!f.calls.some(c => c[0] === 'send-keys'));
    f = fake();
    assert.equal((await restartChat(sid, { ...f.opts(cleared), session }).catch(e => e)).status, 409);
    assert.ok(!f.calls.some(c => c[0] === 'kill-session'));
    // no registry: the old mtime check still refuses
    f = fake({ live: [] });
    assert.equal((await send(sid, 'hi', fresh, f.opts(null)).catch(e => e)).status, 409);
    assert.deepEqual(f.calls.map(c => c[0]), ['has-session']);
    // the prompt never shows: 504, nothing typed
    f = fake({ live: [], panes: () => 'loading' });
    assert.equal((await send(sid, 'hi', session, f.opts(new Map())).catch(e => e)).status, 504);
    assert.ok(!f.calls.some(c => c[0] === 'send-keys'));

    // asking, but no question on screen: fail closed; with the question up it is cancelled, then typed
    f = fake();
    assert.equal((await send(sid, 'hi', { ...session, asking: true }, f.opts(new Map())).catch(e => e)).status, 409);
    assert.deepEqual(f.keys(), [['has-session', '-t', '=cc-dddddddd']]);
    f = fake({ panes: calls => (calls.some(c => c.includes('Escape')) ? '❯ ' : q) });
    await send(sid, 'hi', { ...session, asking: true }, f.opts(new Map()));
    assert.deepEqual(f.keys().slice(1), [['send-keys', '-t', '=cc-dddddddd:', 'Escape'], ...typed('cc-dddddddd', 'hi')]);
    // a question shows up between typing and Enter: no Enter
    f = fake({ panes: calls => (calls.some(c => c.includes('-l')) ? q : '❯ ') });
    assert.equal((await send(sid, 'hi', session, f.opts(new Map())).catch(e => e)).status, 409);
    assert.ok(!f.calls.some(c => c.at(-1) === 'Enter'));
    // the refused text stays in Claude's input: sending it again only presses Enter, so Claude doesn't get it twice
    f = fake();
    await send(sid, 'hi', session, f.opts(new Map()));
    assert.deepEqual(f.keys().slice(1), [['send-keys', '-t', 'cc-dddddddd', 'Enter']]);
    f = fake();
    await send(sid, 'hi', session, f.opts(new Map()));
    assert.deepEqual(f.keys().slice(1), typed('cc-dddddddd', 'hi'), 'only the next send');

    // one action per tmux at a time, in arrival order; a failure doesn't block the next
    const order = [];
    const tick = () => new Promise(r => setTimeout(r, 5));
    await Promise.all([
        withLock('cc-x', async () => { order.push('a1'); await tick(); order.push('a2'); }),
        withLock('cc-x', async () => { order.push('b'); throw new Error('boom'); }).catch(() => order.push('b failed')),
        withLock('cc-y', async () => { order.push('other'); }),
        withLock('cc-x', async () => { order.push('c'); })
    ]);
    assert.deepEqual(order, ['a1', 'other', 'a2', 'b', 'b failed', 'c']);
    // two sends at once: keystrokes never interleave
    f = fake();
    const slow = { ...f.opts(new Map()), nap: tick };
    await Promise.all([send(sid, 'one', session, slow), send(sid, 'two', session, slow)]);
    assert.deepEqual(f.keys().filter(c => c[0] === 'send-keys'), [...typed('cc-dddddddd', 'one'), ...typed('cc-dddddddd', 'two')]);
    console.log('ok send');
}

import { parseQuestion, answerQuestion } from './server.mjs';
import { seenHash } from './public/core.js';
{
    const ask = sel => `❯ Ask me which color
────────────────
 ☐ Color

Which color
do you want?

${sel === 0 ? '❯' : ' '} 1. Green (Recommended)
     calm and
     quiet
${sel === 1 ? '❯' : ' '} 2. Red
     warm
${sel === 2 ? '❯' : ' '} 3. Blue
  4. Type something.
────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    assert.deepEqual(parseQuestion(ask(0)), {
        question: 'Which color do you want?',
        options: ['Green (Recommended)', 'Red', 'Blue', 'Type something.', 'Chat about this'],
        descriptions: ['calm and quiet', 'warm', '', '', ''],
        selected: 0
    });
    assert.equal(parseQuestion(ask(2)).selected, 2);
    assert.equal(parseQuestion(ask(0).replace('Enter to select', '')), null, 'needs the hint');
    assert.equal(parseQuestion(ask(0).replace('1. Green', '1. [ ] Green')), null, 'multi-select is left to the terminal');
    const submit = '←  ☒ Size  ☒ Shape  ✔ Submit  →\n\nReview your answers\n\n ● Which size?\n   → Large\n ● Which shape?\n   → Square\n\n❯ 1. Submit answers\n  2. Cancel\n\n';
    assert.deepEqual(parseQuestion(submit), { question: 'Review your answers · Which size? → Large · Which shape? → Square', options: ['Submit answers', 'Cancel'], descriptions: ['', ''], selected: 0 }, 'the submit step has no hint');
    assert.equal(parseQuestion('❯ 1. my typed list\n'), null, 'no hint, no review: not a question');
    assert.equal(parseQuestion(' Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm'), null, 'not a question');

    const run = async (panes, index, label, name = 'cc-new-probe') => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void sent.push(a));
        const seen = seenHash(parseQuestion(panes[0]) ?? { question: '' });
        const err = await answerQuestion(name, index, label, { tm, nap: async () => {}, seen }).then(() => null, e => e);

        return { sent, err };
    };
    assert.equal((await answerQuestion('cc-new-probe', 0, 'Red', { tm: async () => ({ stdout: '' }) }).catch(e => e)).status, 400, 'no seen: refused');
    let r = await run([ask(0), ask(1), 'Red'], 1, 'Red');
    assert.equal(r.err, null);
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down'], ['Enter']]);
    r = await run([ask(0), ask(0), ask(0), ask(2), 'Blue'], 2, 'Blue');
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down'], ['Down', 'Down'], ['Down', 'Down'], ['Enter']], 'dropped arrows are resent');
    r = await run([ask(0)], 1, 'Red');
    assert.equal(r.err.status, 502, 'arrows never land');
    assert.ok(!r.sent.some(a => a.includes('Enter')), 'never confirms another option');
    r = await run([ask(0), ask(1).replace('Which color', 'Which shade')], 1, 'Red');
    assert.equal(r.err.status, 409, 'the question changed under the arrows');
    assert.ok(!r.sent.some(a => a.includes('Enter')));
    r = await run([ask(0)], 1, 'Blue');
    assert.equal(r.err.status, 409, 'label mismatch');
    assert.deepEqual(r.sent, []);
    assert.equal((await run([ask(0)], 3, 'Type something.')).err.status, 400, 'the text box entry is not answered');
    r = await run([ask(0), ask(0).replace('❯ 1.', '  1.').replace('  5. Chat', '❯ 5. Chat'), 'declined'], 4, 'Chat about this');
    assert.equal(r.err, null, 'Chat about this is selected like an option');
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down', 'Down', 'Down'], ['Enter']]);
    assert.equal((await run([ask(0)], 1, 'Red', 'zsh')).err.status, 400, 'not a cc-* session');
    r = await run([ask(0), ask(1), ask(1).replace('Which color\ndo you want?', 'Which size?')], 1, 'Red');
    assert.equal(r.err, null, 'the next question of a multi-question dialog counts as answered');

    // A tool permission prompt, captured from a real Claude Code: an "Esc to cancel" footer, the command as the question
    const perm = readFileSync(new URL('./tests/fixtures/permission-bash.txt', import.meta.url), 'utf8');
    const p = parseQuestion(perm);
    assert.equal(p.question, 'Bash command · Write and remove a test file · Do you want to proceed?');
    assert.equal(p.detail, 'echo hi > out-from-test.txt && rm out-from-test.txt', 'the command, apart from the question');
    assert.equal(p.risky, false);
    assert.deepEqual(p.options, ['Yes', "Yes, and don't ask again for echo hi and rm out-from-test.txt commands in", 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
    assert.equal(p.selected, 0);
    assert.match(p.descriptions[1], /-to-wrap-it-x\/0123456789abcdef-4f82c6fe07ad\/scratchpad\/perm$/, 'a path cut at the pane edge is joined back');
    const boxed = perm.split('\n').map(l => `│ ${l.padEnd(100)} │`).join('\n');
    assert.deepEqual(parseQuestion(boxed), p, '│ box borders are stripped');
    assert.equal(parseQuestion(perm.replace('Esc to cancel · Tab to amend', 'Esc to cancel · Tab to amend\n\n❯ next prompt\n\nmore\nand more')), null, 'the footer must be at the bottom');
    r = await run([perm, perm.replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No'), 'Denied'], 3, 'No');
    assert.equal(r.err, null);
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down', 'Down'], ['Enter']], 'answered by the same ❯ path');
    const edit = readFileSync(new URL('./tests/fixtures/permission-edit.txt', import.meta.url), 'utf8');
    assert.equal(parseQuestion(edit).question, 'Edit file · foo.js · Do you want to make this edit to foo.js?');
    assert.equal(parseQuestion(edit).detail, '1  const a = 1;\n2 -const b = 2;\n2 +const b = 3;\n3  console.log(a + b);', 'the diff is the detail');
    // a command past 4 lines used to be dropped: approved blind. Now all of it, its indentation kept, and the risky parts flagged
    const longPane = readFileSync(new URL('./tests/fixtures/permission-bash-long.txt', import.meta.url), 'utf8');
    const longCmd = parseQuestion(longPane);
    assert.equal(longCmd.question, 'Bash command · Rebase onto main and force-push the branch · Do you want to proceed?');
    assert.equal(longCmd.detail.split('\n').length, 8);
    assert.equal(longCmd.detail.split('\n')[6], '  git push --force origin feature &&');
    assert.equal(longCmd.risky, true);
    r = await run([longPane, longPane.replace('glab mr merge 42', 'glab mr merge 43')], 3, 'No');
    assert.ok(!r.sent.some(a => a.includes('Enter')));
    assert.equal(r.err.status, 409, 'a command that changed under the arrows is not answered');
    // the answer carries a hash of what the card showed: only that exact prompt is approved
    const swapped = longPane.replace('glab mr merge 42', 'glab mr merge 43');
    assert.notEqual(seenHash(longCmd), seenHash(parseQuestion(swapped)));
    assert.equal(seenHash(longCmd), seenHash({ question: longCmd.question, detail: longCmd.detail }), 'stable');
    const answerSeen = async (pane, seen) => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: pane } : void sent.push(a));
        const err = await answerQuestion('cc-new-probe', 0, 'Yes', { tm, nap: async () => {}, seen }).then(() => null, e => e);

        return { sent, err };
    };
    r = await answerSeen(swapped, seenHash(longCmd));
    assert.deepEqual([r.err?.status, r.err?.message, r.sent], [409, 'The command changed — check it again', []], 'a replaced command is refused before any key');
    r = await answerSeen(longPane, seenHash(longCmd));
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Enter']], 'the command seen is approved');
    assert.deepEqual(parseQuestion(edit).options, ['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this', 'No']);
    console.log('ok ask question');
}

import { saveUpload, readUpload, UPLOAD_MAX, UPLOAD_NAME } from './server.mjs';
{
    // Chat image uploads: allowed types only, 10 MB cap (also mid-stream), a generated name, and a serve-name check
    const dir = mkdtempSync(join(tmpdir(), 'homebase-uploads-'));
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const status = p => p.then(() => null, e => e.status);
    for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', undefined, '']) {
        assert.equal(await status(saveUpload([png], type, png.length, dir)), 415, String(type));
    }
    assert.equal(await status(saveUpload([png], 'image/png', UPLOAD_MAX + 1, dir)), 413, 'declared length');
    let read = 0;
    const big = (function* () { for (let i = 0; i < 20; i++) { read++; yield Buffer.alloc(1024 * 1024); } })();
    assert.equal(await status(saveUpload(big, 'image/png', undefined, dir)), 413, 'streamed length');
    assert.equal(read, 11, 'stops reading past the cap');
    assert.equal(await status(saveUpload([], 'image/png', 0, dir)), 400);
    assert.deepEqual(readdirSync(dir), [], 'nothing stored for a refused upload');

    const path = await saveUpload([png], 'image/png; charset=binary', png.length, dir);
    const name = path.slice(dir.length + 1);
    assert.equal(path, join(dir, name));
    assert.match(name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    assert.match(await saveUpload([png], 'IMAGE/JPEG', 8, dir), /\.jpg$/);
    assert.deepEqual(await readUpload(name, dir), { type: 'image/png', body: png });
    assert.equal(await readUpload(name.replace('.png', '.gif'), dir), null, 'missing file');
    for (const bad of ['../items.json', `..%2F${name}`, `../uploads/${name}`, `${name}/..`, name.replace('.png', '.svg'), `a${name}`, '%2e%2e%2fitems.json', '']) {
        assert.ok(!UPLOAD_NAME.test(bad), bad);
        assert.equal(await readUpload(bad, dir), null, bad);
    }
    rmSync(dir, { recursive: true, force: true });
    console.log('ok uploads');
}

import { pasteLabel, isLongPaste, expandPastes } from './public/chat.js';
{
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(pasteLabel(3, long), '[Pasted text #3 +12 lines]');
    assert.ok(isLongPaste(long) && isLongPaste('x'.repeat(801)) && !isLongPaste('a\nb'));
    assert.equal(expandPastes(`see ${pasteLabel(3, long)} and [Pasted text #9 +2 lines]`, { 3: long }), `see ${long} and [Pasted text #9 +2 lines]`, 'unknown labels stay as typed');
    console.log('ok paste labels');
}

import { cancelQuestion, questionOpen } from './server.mjs';
{
    const q = '│ What bothers you?\n❯ 1. [✔] Logo looks bad\n  2. [ ] Too plain\n     Next\n  6. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
    const trust = ' Accessing workspace:\n /x\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel\n';
    assert.ok(questionOpen(q) && !questionOpen(trust) && !questionOpen('❯ hello\n'));
    const run = async panes => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void sent.push(a));
        const r = await cancelQuestion('cc-new-x', { tm, nap: async () => {} }).catch(e => e);
        return { r, sent };
    };
    let { r, sent } = await run(['idle']);
    assert.equal(r, false); assert.deepEqual(sent, []);
    ({ r, sent } = await run([q, q, 'declined']));
    assert.equal(r, true); assert.deepEqual(sent, [['send-keys', '-t', '=cc-new-x:', 'Escape']]);
    ({ r } = await run([q]));
    assert.equal(r.status, 502, 'still open');
    assert.equal((await cancelQuestion('zsh', { tm: async () => ({ stdout: q }) }).catch(e => e)).status, 400);
    console.log('ok cancel question');
}

import { claudeLine } from './server/tmux.mjs';
{
    assert.equal(claudeLine(' --resume x', '/nope/rules.md'), 'claude --resume x', 'no rules file: plain claude');
    assert.match(claudeLine(' --resume x'), /^claude --append-system-prompt-file '.*\/homebase-rules\.md' --resume x$/);
    console.log('ok claude line');
}

import { projectOf } from './server/sessions.mjs';
{
    // a failed git lookup gives the folder name but is not cached; a good one is, and every call gets a timeout
    let calls = 0, opts;
    const bad = async () => { calls++; throw new Error('timed out'); };
    assert.equal(await projectOf('/x/y/proj-a', bad), 'proj-a');
    await projectOf('/x/y/proj-a', bad);
    assert.equal(calls, 4, 'asked git again (2 commands per call)');
    const good = async (_c, _a, o) => { opts = o; calls++; return { stdout: 'git@h:g/repo-b.git\n' }; };
    calls = 0;
    assert.equal(await projectOf('/x/y/proj-b', good), 'repo-b');
    await projectOf('/x/y/proj-b', bad);
    assert.equal(calls, 1);
    assert.equal(opts.timeout, 5000);
    console.log('ok projectOf no cache on failure');
}

// item age: forge-seeded MRs (no agent, no link time) take the MR's own update; nothing known stays 0
assert.equal(itemUpdated(null, 0, { updatedAt: 5000 }), 5000);
assert.equal(itemUpdated({ updated: 9000 }, 100, { updatedAt: 5000 }), 9000);
assert.equal(itemUpdated(null, 0, null), 0);
// limits pace: 10% in 10 minutes -> 90% left lasts 90 minutes, if that is before the reset
{
    const t = 1_000_000_000, m = 60_000;
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 50]], t + 10 * m + 120 * m, t + 10 * m), 50);
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 50]], t + 10 * m + 30 * m, t + 10 * m), null); // resets first
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 40]], t + 500 * m, t + 10 * m), null); // flat
    assert.equal(runOutIn([[t, 40], [t + m, 45]], t + 500 * m, t + m), null); // too short to trust
    assert.equal(runOutIn([[t, 40]], t + 500 * m, t), null);
}

assert.equal(chatMessage({ iid: 9, st: 'closable', mrs: [{ iid: 30, state: 'merged' }] }), 'Close #9, its MR !30 is merged');
assert.equal(reviewNote([{ next: 'Waiting for review by Ann' }, { next: 'Waiting for review by Ann' }]), 'all waiting on Ann');
assert.equal(reviewNote([{ next: 'Waiting for review by Ann' }, { next: 'Needs a reviewer' }]), '');
assert.equal(reviewNote([]), '');

import { rulesStale, reloadMessage } from './server/rules.mjs';
import { RULES_FILE } from './server/tmux.mjs';
{
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const home = join(dir, 'home'), cwd = join(dir, 'proj');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    const touch = (p, ms) => { writeFileSync(p, 'x'); utimesSync(p, ms / 1000, ms / 1000); };
    touch(join(home, '.claude', 'CLAUDE.md'), 1_000_000);
    touch(join(cwd, 'CLAUDE.md'), 2_000_000);
    const stale = (started, now) => rulesStale(started, cwd, now, home);
    assert.equal(await stale(Date.now(), 1e12), undefined, 'newer process: fresh');
    assert.equal(await stale(undefined, 1e13), undefined, 'unknown start: nothing inferred');
    const r = await stale(1_500_000, 1e14); // past the 10s cache, so the files are re-read; the real homebase-rules.md is listed too
    assert.ok(r.names.includes('CLAUDE.md') && r.at >= 2_000_000);
    assert.ok(r.reload.startsWith('The rules changed. Re-read /') && r.reload.includes(`homebase-rules.md, ~/.claude/CLAUDE.md and ${join(cwd, 'CLAUDE.md')} now and follow them`), r.reload);
    assert.equal(reloadMessage(), `The rules changed. Re-read ${RULES_FILE} and ~/.claude/CLAUDE.md now and follow them from here on (they override your earlier instructions where they differ).`);
    touch(join(cwd, 'AGENTS.md'), 5_000_000);
    assert.ok(!(await stale(1_500_000, 1e14 + 1000)).names.includes('AGENTS.md'), 'mtimes are cached for 10s');
    assert.ok((await stale(1_500_000, 1e14 + 20_000)).names.includes('AGENTS.md'));
    rmSync(dir, { recursive: true });
    console.log('ok rules stale');
}

import { encrypt, vapidKeys, vapidJwt, pushTo, validSub, readSubs, addSub, removeSub, removeDeviceSubs, pushEvents, watchSessions, pageFocused } from './server/push.mjs';
{
    // RFC 8291 section 5 test vector
    const out = encrypt('When I grow up, I want to be a watermelon', { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') });
    assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    console.log('ok push RFC 8291 vector');
}
{
    // VAPID: keys made once (0600, same on a second call), JWT is ES256 over header.payload with the push service's origin as aud
    const { createPublicKey, verify, createECDH } = await import('node:crypto');
    const dir = mkdtempSync(join(tmpdir(), 'hb-push-'));
    const keys = await vapidKeys(dir);
    assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')), keys);
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    const jwt = vapidJwt('https://web.push.apple.com', keys, 1_000_000_000);
    const [h, p, sig] = jwt.split('.');
    assert.deepEqual(JSON.parse(String(Buffer.from(h, 'base64url'))), { typ: 'JWT', alg: 'ES256' });
    assert.deepEqual(JSON.parse(String(Buffer.from(p, 'base64url'))), { aud: 'https://web.push.apple.com', exp: 1_000_000 + 43200, sub: 'mailto:homebase@example.com' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.ok(!verify('sha256', Buffer.from(`${h}.${p}x`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

    // a push carries the headers and an encrypted body the subscriber can open
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
    let got;
    assert.equal(await pushTo(sub, { title: 't' }, keys, async (url, headers, body) => { got = { url, headers, body }; return 201; }), 201);
    assert.equal(got.url, sub.endpoint);
    assert.match(got.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    assert.equal(JSON.parse(String(Buffer.from(got.headers.authorization.split('.')[1], 'base64url'))).aud, 'https://fcm.googleapis.com');
    assert.deepEqual([got.headers.ttl, got.headers.urgency, got.headers['content-encoding'], got.headers['content-length']], ['3600', 'high', 'aes128gcm', got.body.length]);
    assert.equal(got.body.readUInt32BE(16), 4096);
    assert.equal(got.body[20], 65);

    // the subscription store: validated, deduped by endpoint, 0600, removed on 404/410 from the push service
    assert.ok(validSub(sub));
    assert.ok(!validSub({ ...sub, endpoint: 'https://evil.example/push' }));
    assert.ok(!validSub({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.example/x' }));
    assert.ok(!validSub({ ...sub, endpoint: 'http://fcm.googleapis.com/x' }));
    assert.ok(!validSub({ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }));
    assert.ok(!validSub({ endpoint: sub.endpoint }));
    assert.ok(!validSub(null));
    await addSub(dir, sub);
    await addSub(dir, { ...sub, extra: 1 });
    const other = { ...sub, endpoint: 'https://web.push.apple.com/xyz' };
    await addSub(dir, other);
    assert.deepEqual(await readSubs(dir), [sub, other]);
    assert.equal(statSync(join(dir, 'subscriptions.json')).mode & 0o777, 0o600);
    await removeSub(dir, other.endpoint);
    assert.deepEqual(await readSubs(dir), [sub]);
    await addSub(dir, other, 'dev1');
    await removeDeviceSubs(dir, 'dev1');
    assert.deepEqual(await readSubs(dir), [sub], 'revoking a device drops its subscriptions');

    // the watcher: the first list only sets the baseline; a new transition pushes to every device unless a page was focused
    const s = (id, extra = {}) => ({ id, project: 'alpha', status: 'idle', asking: false, needsYou: false, ...extra });
    const sent = [];
    const post = async url => { sent.push(url); return url === other.endpoint ? 410 : 201; };
    await addSub(dir, other);
    await watchSessions(dir, [s('a', { asking: true, question: 'Which one?' })], 0, post);
    assert.equal(sent.length, 0);
    await watchSessions(dir, [s('a', { asking: true, question: 'Which one?' }), s('b', { needsYou: true, lastReply: 'Cookie scope?' })], 1000, post);
    assert.deepEqual(sent.sort(), [other.endpoint, sub.endpoint].sort());
    assert.deepEqual(await readSubs(dir), [sub], 'the 410 one is gone');
    pageFocused(2000);
    await watchSessions(dir, [s('a'), s('b'), s('c', { asking: true })], 3000, post);
    assert.equal(sent.length, 2, 'a focused page within the minute: no push');
    rmSync(dir, { recursive: true });
    console.log('ok push vapid, send, store, watcher');
}
{
    // transitions: into asking or needs-you, one per session per 30s, never from subagent transcripts or a working chat
    const s = (id, extra = {}) => ({ id, project: 'alpha', status: 'idle', asking: false, needsYou: false, ...extra });
    const sent = new Map();
    let r = pushEvents(null, [s('a', { asking: true })], sent, 0);
    assert.deepEqual(r.events, []);
    r = pushEvents(r.next, [s('a', { asking: true }), s('b', { needsYou: true, lastReply: 'Pick one' }), s('w', { needsYou: true, status: 'working' }), s('x', { asking: true, sidechain: true })], sent, 1000);
    assert.deepEqual(r.events, [{ title: 'alpha needs you', body: 'Pick one', tag: 'b', chat: 'b' }]);
    r = pushEvents(r.next, [s('a'), s('b')], sent, 2000);
    r = pushEvents(r.next, [s('a', { asking: true, question: 'Which?' }), s('b', { needsYou: true })], sent, 3000);
    assert.deepEqual(r.events.map(e => [e.chat, e.body]), [['a', 'Which?']], 'b again within 30s is debounced');
    r = pushEvents(r.next, [s('a', { asking: true }), s('b')], sent, 40_000);
    r = pushEvents(r.next, [s('a', { asking: true }), s('b', { needsYou: true })], sent, 41_000);
    assert.deepEqual(r.events.map(e => e.chat), ['b'], 'a still asking: no new push');
    console.log('ok push transitions');
}

import { isStale, serverMtime, pageHash } from './server.mjs';
{
    assert.equal(isStale(1000, 1000), false);
    assert.equal(isStale(1000, 1001), true);
    // touching a server or browser file moves serverMtime or pageHash; in a stand-in tree, as other runs and agents touch the real one
    const dir = codeDir(), old = process.env.HOMEBASE_CODE_DIR;
    process.env.HOMEBASE_CODE_DIR = dir;
    const bump = async (file, read) => {
        const before = await read();
        utimesSync(join(dir, file), new Date(), new Date(Date.now() + 60_000));
        return [before, await read()];
    };
    try {
        const [m0, m1] = await bump('server/rules.mjs', serverMtime);
        assert.ok(isStale(m0, m1), 'server code change is stale');
        const [h0, h1] = await bump('public/styles.css', pageHash);
        assert.notEqual(h0, h1, 'browser file change moves the page hash');
    } finally {
        if (old === undefined) {
            delete process.env.HOMEBASE_CODE_DIR;
        } else {
            process.env.HOMEBASE_CODE_DIR = old;
        }
        rmSync(dir, { recursive: true });
    }
    console.log('ok stale detection');
}
