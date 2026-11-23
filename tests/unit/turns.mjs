import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { status, summarize, pendingQuestion, turnState, askMarker, markerAsk, helperAsk, openToolUse, askingHelper, findClearedSuccessor, tmuxFor, lastActivity, linkClears } from '../../server.mjs';

// Turn state, from real entry shapes (Claude Code 2.1.3xx).
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
    assert.deepEqual(turnState(turn, 31 * 60_000), { state: 'stuck', since: null, died: true });
    assert.equal(state([...turn, td('55:43')], 31 * 60_000), 'idle');
    // the session list uses it too
    assert.equal(status(turn.at(-1), 5 * 60_000, turnState(turn, 5 * 60_000)), 'working');
    assert.equal(status(turn.at(-1), 5 * 60_000, { state: 'asking' }), 'waiting');
    assert.equal(summarize([...turn, td('55:43')], 1_000).status, 'waiting');
    // the open turn's newest tool call is its Now line, with when it started
    const running = summarize([...turn, tool('n', '55:42', 'Bash')], 1_000);
    assert.deepEqual([running.status, running.step, running.stepAt], ['working', 'running ', Date.parse(at('55:42'))]);
    console.log('ok turn state');
}

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
    // a permission prompt with no tool of the main chat's own waiting on it belongs to a background helper (they share the pane)
    const bash = { type: 'assistant', timestamp: at('26:00'), message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: {} }] } };
    assert.equal(helperAsk(perm, turn, now), true, 'only an Agent call is open');
    assert.equal(helperAsk(perm, [...turn, bash], now), false, 'the main chat\'s own Bash waits');
    assert.equal(helperAsk(perm, [...turn, bash, result('b1', '26:01')], now), true, 'its Bash finished before the prompt');
    assert.equal(helperAsk(ask, turn, now), false, 'a question is not a permission prompt');
    assert.equal(helperAsk(null, turn, now), false);
    // the helper that asks is the one running helper whose own transcript ends in an unanswered tool call
    assert.equal(openToolUse([bash]), true);
    assert.equal(openToolUse([bash, result('b1', '26:01')]), false);
    const h = (id, status, openTool) => ({ id, status, openTool });
    assert.equal(askingHelper([h('a', 'running', true), h('b', 'running', false), h('c', 'done', true)]), 'a');
    assert.equal(askingHelper([h('a', 'running', true), h('b', 'running', true)]), null, 'several: unknown');
    assert.equal(askingHelper([h('a', 'running', false)]), null, 'none: unknown');
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
    // a permission prompt is over once it is answered: Claude's input box is back on the pane, though the hook only clears
    // the marker when the approved tool finishes. Still asking with the prompt up, or with no pane to look at
    const permPane = readFileSync(new URL('../fixtures/permission-bash.txt', import.meta.url), 'utf8');
    const running = '⏺ Bash(sleep 600)\n  ⎿  Running…\n\n✻ Working… (12s)\n\n──────────\n❯ \n──────────\n  ? for shortcuts\n';
    const seen = [];
    const shows = pane => ({ tm: async a => { seen.push(a); return { stdout: pane }; } });
    assert.equal((await askMarker(id, shows(permPane))).permission, 'Claude needs your permission to use Bash');
    assert.equal((await askMarker(id, shows(''))).permission, 'Claude needs your permission to use Bash');
    assert.equal(await askMarker(id, shows(running)), null, 'approved: the tool runs, nothing is asked');
    assert.deepEqual(seen[0], ['capture-pane', '-p', '-t', '=cc-5010a555:']);
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
    const pick = { type: 'user', timestamp: ts('06'), message: { role: 'user', content: '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>' } };
    assert.equal(lastActivity([...real, pick, ...book]), Date.parse(ts('06')), 'a slash command the user ran (a /model pick) is: auto-compact waits');
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
