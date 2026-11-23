import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chatItems, workItems, addUsage, readUsage, formatDuration, formatTokens, limitsOf, peakLimits } from '../../server.mjs';
import { canned } from '../../public/canned.js';
import { commandRun, limitLeft, modelName, limitView } from '../../public/core.js';
import { keepModelSetting } from '../../server/control.mjs';
import { unpushedOf } from '../../server/sessions.mjs';
import { reloadMessage } from '../../server/rules.mjs';
import { tu, say, T, open, mr, agent, now } from './helpers.mjs';

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
{
    const u = text => ({ type: 'user', message: { content: text } });
    const res = (id, extra) => ({ type: 'user', timestamp: 't9', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'r', ...extra }] } });
    const stop = u('[Request interrupted by user]');

    // Esc on a turn that only ran tools so far marks that turn, not the previous turn's finished reply
    const esc = chatItems([u('go'), say('All done with A.'), u('now B'), tu('Bash', { id: 'b0' }), res('b0'), stop]);
    assert.deepEqual(esc.map(i => [i.role, !!i.interrupted]), [['user', false], ['assistant', false], ['user', false], ['tools', false], ['tools', true]]);
    assert.equal(chatItems([u('go'), tu('Bash', { id: 'b0' }), stop]).at(-1).interrupted, true); // no reply at all yet
    console.log('ok interrupted turn without text');

    // an answered AskUserQuestion shows its questions with the answer; a reply from before other work is not tagged
    const askQ = tu('AskUserQuestion', { id: 'a1', input: { questions: [{ question: 'Which cache?' }, { question: 'Which port?' }] } });
    const picked = { ...res('a1'), toolUseResult: { answers: { 'Which cache?': 'Redis', 'Which port?': '8080' } } };
    const shown = i => `${i.tldr ?? ''}\n${i.text}`;
    const alone = chatItems([u('go'), askQ, picked]);
    assert.deepEqual(alone.map(i => [i.role, i.answer?.text]), [['user', undefined], ['assistant', 'Redis · 8080']]);
    assert.ok(shown(alone[1]).includes('Which cache?') && shown(alone[1]).includes('Which port?'));
    const later = chatItems([u('go'), say('Should I read the config first?'), tu('Read', { id: 'r1' }), res('r1'), askQ, picked, say('Using Redis.')]);
    assert.deepEqual(later.map(i => [i.role, i.answer?.text, !!i.needsYou]), [['user', undefined, false], ['assistant', undefined, false], ['tools', undefined, false], ['assistant', 'Redis · 8080', false], ['assistant', undefined, false]]);
    assert.ok(shown(later[3]).includes('Which cache?') && !shown(later[3]).includes('Using Redis'));
    // asked right after its own text: one bubble, question included
    const own = chatItems([u('go'), say('Two things to settle.'), askQ, picked]);
    assert.deepEqual(own.map(i => [i.role, i.answer?.text]), [['user', undefined], ['assistant', 'Redis · 8080']]);
    assert.ok(shown(own[1]).includes('Two things to settle.') && shown(own[1]).includes('Which cache?'));
    console.log('ok answered question in the feed');

    // a failed tool call makes its activity line visible and counted
    const failed = chatItems([u('go'), tu('Bash', { id: 'b1' }), tu('Bash', { id: 'b2' }), res('b1', { is_error: true }), res('b2'), say('Hm.')]);
    assert.deepEqual(failed.map(i => [i.role, i.quiet, i.failed]), [['user', undefined, undefined], ['tools', false, 1], ['assistant', undefined, undefined]]);
    assert.deepEqual(chatItems([u('go'), tu('Bash', { id: 'b1' }), res('b1')]).map(i => [i.quiet, i.failed]), [[undefined, undefined], [true, undefined]]);
    const pushed = chatItems([u('go'), tu('Bash', { id: 'b3', input: { command: 'git push origin x' } }), res('b3', { is_error: true })]);
    assert.deepEqual([pushed[1].risky, pushed[1].failed], [true, 1]);
    console.log('ok failed tool calls');

    // a plan-mode plan is a Claude bubble, not "used 1 other tool"
    const plan = chatItems([u('plan it'), tu('ExitPlanMode', { id: 'p1', input: { plan: '1. Rename the widget\n2. Ship it' } })]);
    assert.deepEqual(plan.map(i => i.role), ['user', 'assistant']);
    assert.ok(shown(plan[1]).includes('Rename the widget'));
    console.log('ok plan in the feed');

    // slash-command and bash-mode output in the transcript are command items
    const sys = content => ({ type: 'system', subtype: 'local_command', timestamp: 't5', content });
    const cmds = chatItems([
        u('<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>'),
        u('<local-command-stdout>\x1b[1mTokens: 12k\x1b[22m</local-command-stdout>'),
        sys('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'), sys('<local-command-stdout>Set</local-command-stdout>'),
        u('<bash-input>ls</bash-input>'), u('<bash-stdout>a.txt</bash-stdout><bash-stderr>no such dir</bash-stderr>'),
        u('<command-name>/clear</command-name>'), u('<local-command-stdout></local-command-stdout>')
    ]);
    assert.deepEqual(cmds.map(i => [i.role, i.cmd, i.text]), [['command', '/context', 'Tokens: 12k'], ['command', '/model opus', 'Set'], ['command', '! ls', 'a.txt\nno such dir']]);
    console.log('ok command output in the feed');

    // commands with nothing between them are one run, shown as one line
    assert.deepEqual([commandRun(cmds, 0).length, commandRun(cmds, 1), commandRun(cmds, 2)], [3, [], []]);
    const apart = chatItems([u('<bash-input>ls</bash-input>'), u('<bash-stdout>a</bash-stdout>'), u('and now?'), u('<bash-input>pwd</bash-input>'), u('<bash-stdout>/x</bash-stdout>')]);
    assert.deepEqual([apart.map(i => i.role), commandRun(apart, 0).length, commandRun(apart, 2).length], [['command', 'user', 'command'], 1, 1], 'a message between them: each its own line');
    assert.deepEqual([0, 1, 2].map(n => commandRun([cmds[0], { ...cmds[1], hint: 'Pick this in the terminal' }, cmds[2]], n).length), [1, 1, 1], 'one with a hint stays its own line');
    console.log('ok command runs');

    // a button's message is a labelled item that keeps its whole text; a typed one that only resembles it is a plain bubble
    const fix = canned('fix', '!4 (https://gitlab.com/g/p/-/merge_requests/4)');
    const sent = [reloadMessage(['/p/CLAUDE.md']), fix.message, canned('continue', 'Fix login').message, 'Implement #12', 'Close #9, its MR !30 is merged',
        `${reloadMessage()} Also tidy up.`, `Please ${fix.message}`, 'Implement #12 the way we discussed', 'The rules changed.'];
    const labelled = chatItems(sent.map(u));
    assert.deepEqual(labelled.map(i => i.text), sent, 'the text is kept');
    assert.deepEqual(labelled.map(i => i.label), ['Load new rules', 'Fix & reply !4', 'Continue Fix login', 'Start #12', 'Close #9', undefined, undefined, undefined, undefined]);
    assert.equal(fix.label, 'Fix & reply');
    console.log('ok button messages in the feed');

    // a subagent's result rides along on its "Agent finished" line
    const note = (status, extra) => u(`<task-notification>\n<task-id>x</task-id>\n<status>${status}</status>\n<summary>Agent "Fix login" ${status}</summary>\n${extra}</task-notification>`);
    const fin = chatItems([u('go'), note('completed', '<result>Fixed the redirect.\n\nTwo files.</result>\n<usage>1</usage>\n'), note('failed', '')]);
    assert.deepEqual(fin.map(i => [i.role, i.detail]), [['user', undefined], ['tools', 'Fixed the redirect.\n\nTwo files.'], ['error', undefined]]);
    console.log('ok agent result in the feed');
}

const dump = (five, fiveReset, week = 10) => ({ rate_limits: { five_hour: { used_percentage: five, resets_at: fiveReset }, seven_day: { used_percentage: week, resets_at: 1738857600 } } });
const peaks = new Map();
assert.deepEqual(peakLimits(peaks, [dump(70, 1738425600), dump(90, 1738425600)], now), { fiveHour: { used: 90, resetsAt: 1738425600_000 }, sevenDay: { used: 10, resetsAt: 1738857600_000 } });
assert.equal(peakLimits(peaks, [dump(70, 1738425600)], now).fiveHour.used, 90); // a stale dump never lowers it
assert.equal(peakLimits(peaks, [], now).fiveHour.used, 90); // remembered across polls
assert.deepEqual(peakLimits(peaks, [dump(5, 1738443600)], 1738425600_000 + 1).fiveHour, { used: 5, resetsAt: 1738443600_000 }); // new window starts fresh
assert.equal([...peaks.keys()].some(k => k.includes('1738425600000')), false); // expired window dropped
assert.equal(peakLimits(new Map(), [{}], now), null);
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
    // one backup per run, taken before the first rewrite: the file as Claude Code left it
    const backups = readdirSync(dir).filter(n => n.endsWith('.bak'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, backups[0]), 'utf8')), { a: 1, model: 'fable', b: 2 });
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
const thu = new Date(2026, 10, 12, 23, 43).getTime(); // local time, so the reset clock reads the same in any zone
assert.deepEqual(limitView(false, { used: 30, resetsAt: thu + 97 * 60_000 }, thu),
    { label: 'Session', left: 70, when: '01:20', text: '70%', tip: '70% left of your 5-hour limit · resets in 1h37m (01:20)' });
assert.deepEqual(limitView(true, { used: 37, resetsAt: new Date(2026, 10, 17, 19, 0).getTime() }, thu),
    { label: 'Week', left: 63, when: 'Tue 19:00', text: '63%', tip: '63% left of your weekly limit · resets in 4d19h (Tue 19:00)' });
assert.equal(limitView(false, { used: 81, resetsAt: thu + 97 * 60_000 }, thu).text, '19% · resets 1h37m'); // countdown inline only under 20%
assert.equal(limitView(false, { used: 80, resetsAt: thu + 97 * 60_000 }, thu).text, '20%');
console.log('ok limit peaks');

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
