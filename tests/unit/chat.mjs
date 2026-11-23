import assert from 'node:assert/strict';
import { summarizeAgent, splitTldr, splitTopic, toolSummary, chatItems, pendingQuestion, sendSteps, RISKY, agentStage, refuseIfLiveElsewhere, unwrapPasted, tmuxArgs, queuedPrompts } from '../../server.mjs';
import { tu, say, T } from './helpers.mjs';

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
assert.deepEqual(splitTopic('**▸ Bold closed early** · needs you\nx'), { topic: 'Bold closed early', needsYou: true, text: 'x' });
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
    const { chatFeed } = await import('../../server.mjs');
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
{
    // a trailing ; would end the tmux command and be dropped: typed into a real pane (a private tmux server running cat), it arrives
    const { execFileSync } = await import('node:child_process');
    const socket = `homebase-test-${process.pid}`, t = args => execFileSync('tmux', tmuxArgs(args, socket), { encoding: 'utf8' });
    t(['-f', '/dev/null', 'new-session', '-d', '-s', 'cc-semi', '-x', '80', '-y', '30', 'cat']);
    try {
        for (const text of ['fix this;', 'keep\\;', 'two;;', 'a\nb;']) {
            sendSteps('cc-semi', text).forEach(t);
        }
        await new Promise(r => setTimeout(r, 300));
        const lines = t(['capture-pane', '-p', '-t', 'cc-semi']).split('\n');
        for (const want of ['fix this;', 'keep\\;', 'two;;', 'b;']) {
            assert.ok(lines.includes(want), `${want} arrived whole`);
        }
    } finally {
        t(['kill-server']);
    }
}
console.log('ok chat');

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

const paste = (id, text) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
assert.equal(unwrapPasted(`\n\n${paste('abc1', 'line one\nline two')}`), 'line one\nline two');
assert.equal(unwrapPasted(`see:\n${paste('a', 'X')}\nand ${paste('b', 'Y')} done`), 'see:\nX\nand Y done');
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
    const { isHumanPrompt } = await import('../../server/transcripts.mjs');
    const typed = text => ({ type: 'user', message: { content: text }, timestamp: T('40.000') });
    const lines = ['<div> overflows on mobile', `${paste('p', 'pasted')}`, '<task-notification>\n<task-id>x</task-id>', '<command-name>/clear</command-name>', '<bash-input>ls</bash-input>', '<local-command-stdout>ok</local-command-stdout>', '<artifact-content-authored-by-others/> x'];
    assert.deepEqual(lines.map(t => isHumanPrompt(typed(t))), [true, true, false, false, false, false, false]);
    assert.deepEqual(chatItems(lines.map(typed)).filter(i => i.role === 'user').map(i => i.text), ['<div> overflows on mobile', 'pasted']);
    assert.deepEqual(queuedPrompts([{ type: 'queue-operation', operation: 'enqueue', content: '<b>bold</b> please', timestamp: T('41.000') }]).map(q => q.text), ['<b>bold</b> please']);
}
console.log('ok pasted + dedupe');
