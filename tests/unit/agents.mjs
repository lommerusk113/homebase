import assert from 'node:assert/strict';
import { status, summarize, column, filesTouched, summarizeAgent, agentStatus } from '../../server.mjs';

assert.equal(column('working', { state: 'merged' }, true), 'doing');
assert.equal(column('idle', { state: 'merged' }, true), 'done');
assert.equal(column('idle', { state: 'open', ready: true }, true), 'ready');
assert.equal(column('idle', { state: 'open', changes: true }, true), 'needs-you');
assert.equal(column('idle', { state: 'open', blocked: 'conflict' }, true), 'needs-you');
assert.equal(column('idle', { state: 'open', blocked: 'checks' }, true), 'review'); // nothing to type for an external check
assert.equal(column('waiting', null, true), 'unknown'); // an MR whose lookup gave nothing is not "in review"
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

assert.deepEqual(filesTouched([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/x.js' } }, { type: 'tool_use', name: 'Write', input: { file_path: '/r/b.js' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/a.js' } }] } }
], '/r'), ['a.js', 'b.js']);
console.log('ok files');

const a = summarizeAgent({ description: 'Implement #1', finished: true }, [
    { type: 'assistant', gitBranch: 'b1', message: { content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 'MR open: https://gitlab.com/x/y/-/merge_requests/7.' } }] } }
], 999_999);
assert.deepEqual([a.status, a.pr, a.branch], ['done', 'https://gitlab.com/x/y/-/merge_requests/7', 'b1']);
assert.equal(summarizeAgent({ finished: false }, [], 1_000).status, 'running');
// an agent whose last act was the hand-back call (no result, meta.finished not flipped yet) is done, not running for half an hour
assert.equal(summarizeAgent({ finished: false }, [{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Done.' } }] } }], 5 * 60_000).status, 'done');
// a message after the hand-back resumes the agent: it works again
assert.equal(summarizeAgent({ finished: false }, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'h', name: 'SubagentHandback', input: { message: 'Done.' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'h', content: 'delivered' }] } },
    { type: 'user', message: { content: 'Now rebase it.' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'git fetch' } }] } }
], 5_000).status, 'running');
{
    // a row goes by the newest SendMessage summary sent to that agent
    const { sentSummaries } = await import('../../server.mjs');
    const send = (to, summary) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to, summary, message: 'x' } }] } });
    assert.deepEqual([...sentSummaries([send('a1', 'Merge it'), send('a2', 'Docs'), send('a1', 'Also rebase'), send('a2'), { ...send('a2', 'Nested'), isSidechain: true }])],
        [['a1', 'Also rebase'], ['a2', 'Docs']]);
}
assert.equal(summarizeAgent({ finished: false }, [], 600_000).status, 'stopped');
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
// a persistent Monitor's event notices (no <status>) don't end the watch, and a watch silent for hours is still the agent's own work
{
    const mon = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Monitor started (task bt9p1x, persistent).' }] } };
    const event = { type: 'attachment', attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>bt9p1x</task-id>\n<summary>Monitor event: "ci"</summary>\n<event>red</event>\n</task-notification>' } };
    assert.equal(st([call('a'), mon, event, onHold('Watching CI.')], 11 * MIN).status, 'running', 'event notice keeps the watch open');
    assert.equal(st([call('a'), mon, event, onHold('Watching CI.')], 3 * 60 * MIN).status, 'running', 'no silence cap while it waits');
    assert.equal(st([call('a'), mon, told('bt9p1x'), onHold('Done watching.')], 11 * MIN).status, 'stopped', 'the closing notice ends it');
}
console.log('ok agents');

// a helper the chat stopped (TaskStop) ends on the interrupt: finished, nothing to continue
{
    const asst = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
    const stop = { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
    assert.deepEqual(agentStatus({}, [asst, stop], 1_000), { status: 'done', stopReason: 'killed' });
    assert.equal(agentStatus({}, [asst, stop, asst], 1_000).status, 'running', 'a message after the stop resumes it');
    console.log('ok stopped by the chat');
}

// ...and gets no row on the board
{
    const { workItems } = await import('../../server.mjs');
    const a = (id, extra) => ({ id, description: id, status: 'done', stage: 4, updated: 1, prs: [], ...extra });
    const keys = workItems([{ id: 's', project: 'p', prs: [], agents: [a('kept'), a('gone', { stopReason: 'killed' })] }], () => null, 2, new Map()).map(i => i.key);
    assert.deepEqual(keys, ['kept']);
    console.log('ok stopped by the chat: no row');
}
