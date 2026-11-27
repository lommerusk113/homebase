// Auto-retry and auto-nudge (server/autoretry.mjs): the schedule, the reset, rate limits, silent agents, the marks on rows. Fake sender only.
import assert from 'node:assert/strict';
import { retryStep, autoContinue, apiErrorOf, limitReset, RETRY_DELAYS } from '../../server/autoretry.mjs';
import { summarize, summarizeAgent } from '../../server/sessions.mjs';
import { workItems } from '../../server/items.mjs';
import { isHousekeeping } from '../../server/sendlog.mjs';
import { autoSend, setAutoSender } from '../../server/autosend.mjs';

const S = 1000, MIN = 60 * S;
const err = (text, extra = {}) => ({ type: 'assistant', isApiErrorMessage: true, timestamp: '2026-11-27T10:00:00Z', message: { content: [{ type: 'text', text }] }, ...extra });

// what counts as retryable
assert.equal(apiErrorOf(err('API Error: 529 Overloaded · please retry')).kind, 'transient');
assert.equal(apiErrorOf(err('API Error: Your computer went to sleep mid-response.')).kind, 'transient');
assert.equal(apiErrorOf(err('boom', { error: 'server_error' })).kind, 'transient');
assert.equal(apiErrorOf(err('Please run /login · API Error: 403', { error: 'authentication_failed', apiErrorStatus: 403 })).kind, 'other');
assert.equal(apiErrorOf(err("You've hit your limit", { error: 'rate_limit' })).kind, 'rate-limit');

// a reset time in the message: the next such time, in the local zone only
{
    const at = new Date(2026, 10, 27, 10, 0).getTime();
    assert.equal(limitReset("You've hit your limit · resets 5pm", at, 'X'), new Date(2026, 10, 27, 17, 0).getTime());
    assert.equal(limitReset('limit reached, resets 9:30 AM (X)', at, 'X'), new Date(2026, 10, 28, 9, 30).getTime(), 'already past today: tomorrow');
    assert.equal(limitReset('resets 5pm (Europe/Oslo)', at, 'X'), null, 'another zone: not known');
    assert.equal(limitReset('hit your limit', at, 'X'), null);
}

// transient: 30 s, 2 min, 5 min after each failure; a second failure of the same send waits; the fourth gives up
{
    const c = failedAt => ({ kind: 'transient', failedAt });
    assert.deepEqual(retryStep(undefined, c(0), 29 * S).do, 'wait');
    assert.deepEqual(retryStep(undefined, c(0), 30 * S), { do: 'send', n: 1, retry: { text: 'Retrying (1/3)…' } });
    const st1 = { n: 1, failedAt: 0, sentFor: 0, at: 30 * S };
    assert.equal(retryStep(st1, c(0), 99 * MIN).do, 'wait', 'sent for this failure: no second send');
    assert.equal(retryStep(st1, c(0), 99 * MIN).retry.text, 'Retrying (1/3)…');
    assert.equal(retryStep(st1, c(60 * S), 60 * S + 119 * S).do, 'wait');
    assert.deepEqual(retryStep(st1, c(60 * S), 60 * S + RETRY_DELAYS[1]), { do: 'send', n: 2, retry: { text: 'Retrying (2/3)…' } });
    const st3 = { n: 3, failedAt: 5 * MIN, sentFor: 5 * MIN, at: 5 * MIN };
    assert.deepEqual(retryStep(st3, c(6 * MIN), 99 * MIN), { do: 'give-up', n: 3, retry: { gaveUp: 'retried 3 times' } });
    assert.equal(retryStep(st3, c(5 * MIN + 10 * MIN + 1), 5 * MIN + 10 * MIN + 31 * S).do, 'send', '10 minutes without a failure: the count starts again');
    assert.equal(retryStep(st3, c(5 * MIN + 10 * MIN + 1), 99 * MIN).retry.text, 'Retrying (1/3)…');
}

// rate limit: never without a reset time (not a candidate); with one, once, just after it
{
    const c = { kind: 'rate-limit', failedAt: 0, resetAt: 100 * S };
    assert.equal(retryStep(undefined, c, 129 * S).do, 'wait');
    assert.equal(retryStep(undefined, c, 130 * S).do, 'send');
    assert.equal(retryStep({ n: 1, failedAt: 0, sentFor: 0, at: 130 * S }, c, 999 * S).do, 'wait');
}

// silent: at once, then 60 s apart, three times, then it stays
{
    const c = { kind: 'silent' };
    assert.equal(retryStep(undefined, c, 0).do, 'send');
    assert.equal(retryStep({ n: 1, at: 0 }, c, 59 * S).do, 'wait');
    assert.deepEqual(retryStep({ n: 1, at: 0 }, c, 60 * S), { do: 'send', n: 2, retry: { text: 'Nudging (2/3)…' } });
    assert.deepEqual(retryStep({ n: 3, at: 0 }, c, 99 * MIN), { do: 'give-up', n: 3, retry: { gaveUp: 'nudged 3 times' } });
}

// the pass: a live chat with a transient error is continued when due and only once; marks for the rows; the count survives
{
    const sent = [], saved = [], map = new Map();
    const deps = { send: async (id, text) => { sent.push([id, text]); }, ready: () => true, map, save: async m => { saved.push(m.size); } };
    const agent = (extra = {}) => ({ id: 'a1', description: 'Fix login', status: 'stopped', stopReason: 'api-error', errorKind: 'transient', updated: 1000, ...extra });
    const list = () => [
        { id: 'chat1', title: 'Main', status: 'idle', agents: [agent()] },
        { id: 'helper1', title: 'Helper one', status: 'idle', apiError: { kind: 'transient', at: 1000, resetAt: null }, agents: [] },
        { id: 'chat0', title: 'Parent', status: 'idle', agents: [{ id: 'helper1', helperSession: 'helper1', description: 'Do it', status: 'stopped', stopReason: 'api-error' }] },
        { id: 'auth', status: 'idle', apiError: { kind: 'other', at: 1000 }, agents: [] },
        { id: 'busy', status: 'working', apiError: { kind: 'transient', at: 1000 }, agents: [] },
        { id: 'gone', status: 'idle', apiError: { kind: 'transient', at: 1000 }, agents: [] },
        { id: 'closed', status: 'idle', helper: { closed: 'Closed' }, apiError: { kind: 'transient', at: 1000 }, agents: [] }
    ];
    const live = new Set(['chat1', 'helper1', 'chat0', 'auth', 'busy', 'closed']);
    let l = list();
    autoContinue(l, live, 1000 + 29 * S, deps);
    assert.deepEqual(sent, []);
    assert.equal(l[0].agents[0].retry.text, 'Retrying (1/3)…');
    assert.equal(l[2].agents[0].retry.text, 'Retrying (1/3)…', "the helper's row in its parent is marked too");
    l = list();
    autoContinue(l, live, 1000 + 30 * S, deps);
    await new Promise(r => setTimeout(r, 1));
    assert.deepEqual(sent.map(s => s[0]).sort(), ['chat1', 'helper1'], 'only live, idle chats with a retryable error; one send each');
    assert.equal(sent[0][1], "The subagent 'Fix login' stopped — check why and continue it.");
    autoContinue(list(), live, 1000 + 60 * S, deps);
    assert.equal(sent.length, 2, 'not again for the same failure');
    assert.ok(saved.length > 0);
    // a failure long after: the old entry is pruned once its chat runs fine
    autoContinue([{ id: 'chat1', status: 'idle', agents: [] }], live, 1000 + 40 * MIN, deps);
    assert.equal(map.has('chat1/a1'), false);
    // without a sender nothing is sent or counted
    const none = new Map();
    autoContinue(list(), live, 1000 + 30 * S, { ...deps, ready: () => false, map: none });
    assert.equal(none.size, 0);
    console.log('ok auto-continue');
}

// a send is the chat's own note, not the user's answer
{
    const calls = [];
    setAutoSender(async (id, text) => { calls.push([id, text]); });
    await autoSend('chatX', 'continue now');
    assert.deepEqual(calls, [['chatX', 'continue now']]);
    assert.equal(isHousekeeping('chatX', 'continue now'), true);
    setAutoSender(null);
    await assert.rejects(() => autoSend('chatX', 'x'), /no sender/);
}

// the transcript says so: a chat whose last turn failed, a subagent's error kind
{
    const turn = [{ type: 'user', cwd: '/r', sessionId: 'x', turnPosition: 1, message: { content: 'go' } }, err('API Error: 529 Overloaded')];
    assert.equal(summarize(turn, 5_000).apiError.kind, 'transient');
    assert.equal(summarize([...turn, { type: 'user', message: { content: 'continue' } }], 5_000).apiError, null);
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] } };
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] } };
    assert.equal(summarizeAgent({}, [call, result, err('API Error: 529 Overloaded')], 1_000).errorKind, 'transient');
    assert.equal(summarizeAgent({}, [call, result, err('Please run /login · API Error: 403')], 1_000).errorKind, 'other');
    assert.equal(summarizeAgent({}, [call, result], 1_000).errorKind, null);
}

// the row: Doing with the try it is on while Homebase continues it; out of tries it keeps its Continue and says so
{
    const row = retry => workItems([{ id: 's', project: 'p', prs: [], agents: [{ id: 'h', description: 'Fix login', status: 'stopped', stopReason: 'api-error', updated: 5, started: 1, prs: [], retry }] }], () => null, 10, new Map())[0];
    const going = row({ text: 'Retrying (2/3)…' });
    assert.deepEqual([going.column, going.next, going.action], ['doing', 'Retrying (2/3)…', null]);
    const gaveUp = row({ gaveUp: 'retried 3 times' });
    assert.equal(gaveUp.column, 'needs-you');
    assert.match(gaveUp.next, /API error.* · retried 3 times$/);
    assert.equal(gaveUp.action.label, 'Continue');
    assert.equal(row(undefined).column, 'needs-you');
    console.log('ok retry rows');
}
