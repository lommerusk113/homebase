import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { summarize, chatItems, turnState, readTail, fetchComments, latestTopic, queuedPrompts, parseLog, branchOf, markPushed, chatMilestones, nestCommits, groupByDay } from '../../server.mjs';
import { sessionTopic, startingIssues, workingLine, workingTitle } from '../../public/list.js';
import { say } from './helpers.mjs';

// tracker e9c15e3f: a ~900 KB tool_result line filled the 512 KB tail, so the chat showed one bubble and the 403 vanished
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
{
    // a transcript longer than the parsed tail: the feed says there is more, and a larger `max` ("Show earlier") reads further back
    const { feedTail } = await import('../../server/transcripts.mjs');
    const f = join(mkdtempSync(join(tmpdir(), 'hb-')), 'long.jsonl');
    const pad = 'x'.repeat(4000);
    const rows = Array.from({ length: 400 }, (_, n) => [
        { type: 'user', timestamp: new Date(1e12 + n * 120_000).toISOString(), message: { content: `ask ${n}` } },
        { type: 'assistant', timestamp: new Date(1e12 + n * 120_000 + 1000).toISOString(), pad, message: { content: [{ type: 'text', text: `reply ${n}` }] } },
        { type: 'system', subtype: 'turn_duration', turnPosition: { n } }
    ]).flat();
    writeFileSync(f, rows.map(l => JSON.stringify(l)).join('\n') + '\n');
    const st = statSync(f);
    const short = await feedTail(f, st, 60);
    assert.equal(short.items.length, 60);
    assert.equal(short.more, true);
    assert.ok(short.entries.length < rows.length, 'the default poll parses only the tail');
    const deep = await feedTail(f, st, 600);
    assert.deepEqual([deep.items.length, deep.items[0].text, deep.more], [600, 'ask 100', true]);
    const all = await feedTail(f, st, 10_000);
    assert.deepEqual([all.items.length, all.items[0].text, all.more], [800, 'ask 0', false]);
    // a short transcript has nothing earlier
    const g = join(mkdtempSync(join(tmpdir(), 'hb-')), 'short.jsonl');
    writeFileSync(g, rows.slice(0, 9).map(l => JSON.stringify(l)).join('\n') + '\n');
    assert.equal((await feedTail(g, statSync(g), 60)).more, false);
    console.log('ok show earlier past the tail');
}

// A half-written agent .meta.json or a transcript deleted mid-poll skips that one entry, not the whole /api/sessions
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
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), [['good', ['ok']]]);
    rmSync(home, { recursive: true, force: true });

    assert.deepEqual((await fetchComments('https://example.com/a/b/issues/1')).items, []);
    console.log('ok corrupt meta, vanished transcript, unknown host');
}

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

{
    const ses = (id, project, at, extra = {}) => /** @type {any} */ ({ id, project, lastActivity: at, cwd: `/r/${project}`, sidechain: false, ...extra });
    assert.equal(sessionTopic({ topic: 'Perks simulator', lastPrompt: 'x' }), 'Perks simulator');
    assert.equal(sessionTopic({ topic: null, lastPrompt: '**fix** the  build' }), 'fix the build');
    assert.ok(sessionTopic({ topic: null, lastPrompt: 'word '.repeat(40) }).endsWith('…'));
    const now = Date.now();
    const m = ses('m', 'p', now, { status: 'working', now: 'Implement #2225', queued: ['then #2230 and #2231', 'Implement #2225'] });
    assert.deepEqual(startingIssues(m, []), ['2225', '2230', '2231']);
    const items = /** @type {any[]} */ ([{ title: 'Implement #2230 foo', branch: null }, { title: 'x', branch: '2231-bar' }, { title: 'y', prState: { issue: '2225' } }]);
    assert.deepEqual(startingIssues(m, items), [], 'a subagent title, branch or MR issue covers it');
    assert.deepEqual(startingIssues({ ...m, status: 'idle', queued: [] }, []), [], 'turn over: no placeholder');
    assert.deepEqual(startingIssues({ ...m, now: 'see !2225 and #22250', queued: [] }, [{ title: '#2225' }]), ['22250'], 'MR refs are not issues; #2225 does not cover #22250');
    assert.equal(workingTitle(ses('x', 'p', now, { now: '[Image: /t/a.png]\nFix   the *login*\nredirect', topic: 'Old topic', title: 'First prompt' })), 'Fix the login redirect', 'the request the turn handles');
    assert.equal(workingTitle(ses('x', 'p', now, { now: null, topic: 'Old topic', title: 'First prompt' })), 'Old topic', 'no request: the newest reply topic');
    assert.equal(workingTitle(ses('x', 'p', now, { now: '[Image: /t/a.png]', topic: null, title: 'First prompt' })), 'First prompt', 'nothing else: the title');
    assert.equal(workingTitle(ses('x', 'p', now, { now: 'do it', topic: 'Where the Vue move stands', title: 'First prompt' })), 'Where the Vue move stands', 'a short answer: the topic it answers');
    assert.equal(workingTitle(ses('x', 'p', now, { now: 'yes', topic: null, title: 'First prompt' })), 'yes', 'a short answer with no topic stays');
    assert.equal(workingLine(ses('x', 'p', now, { step: 'running npm test', stepAt: now - 125_000 })), 'p · Now: running npm test · for 2m');
    assert.equal(workingLine(ses('x', 'p', now, { step: null, since: now - 300_000 })), 'p · Now: thinking · for 5m', 'no tool call yet: the turn start');
    assert.equal(workingLine(ses('x', 'p', now, { step: 'editing a.js', stepAt: now })), 'p · Now: editing a.js', 'under a minute: no time');
    console.log('ok sessionTopic');
}

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
    const { contextOf, refuseIfBusy } = await import('../../server.mjs');
    const { isHumanPrompt } = await import('../../server/transcripts.mjs');
    const { mkdtempSync, writeFileSync, rmSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { ctxLevel, canCompact, autoCompactDue, compactNudgeDue, tokenPercent, AUTO_COMPACT } = await import('../../public/core.js');

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
    assert.deepEqual([Math.round(tokenPercent(70_000, {})), tokenPercent(100_000, {}), tokenPercent(100_000, { contextSize: 200_000 }), tokenPercent(200_000, { contextSize: 200_000 })], [7, 10, 50, 90]);
    assert.equal(compactNudgeDue({ context: 7.1 }), true);
    assert.equal(compactNudgeDue({ context: 6.9 }), false);
    assert.equal(compactNudgeDue({ context: 17, contextSize: 400_000 }), false);
    // auto-compact: idle for 2 min, at 100k tokens, no helpers running, not tried within the hour
    const t = 10 * 3600_000, ready = { status: 'idle', context: 10, lastActivity: t - AUTO_COMPACT.idleMs };
    assert.equal(autoCompactDue(ready, t, 0), true);
    assert.equal(autoCompactDue({ ...ready, context: 9.9 }, t, 0), false, 'under the threshold');
    assert.equal(autoCompactDue({ ...ready, subagents: { running: 1, finished: 0 } }, t, 0), false, 'helpers running');
    assert.equal(autoCompactDue({ ...ready, subagents: { running: 0, finished: 2 } }, t, 0), true, 'helpers finished');
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
    // the /compact echo after the boundary adds nothing to the divider; a failed one still shows what went wrong
    const echo = out => [{ type: 'user', message: { content: '<command-name>/compact</command-name>\n<command-args>Keep it short</command-args>' } }, { type: 'user', message: { content: `<local-command-stdout>${out}</local-command-stdout>` } }];
    assert.deepEqual(chatItems([boundary, summary, ...echo('\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m')]).map(i => i.role), ['compact']);
    assert.deepEqual(chatItems(echo('Error: Not enough messages to compact.')).map(i => [i.role, i.cmd]), [['command', '/compact Keep it short']]);
    console.log('ok context and compact');
}
