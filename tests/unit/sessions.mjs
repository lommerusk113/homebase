import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { summarize, turnState, parseDialog, selectSteps, trustFolder, trustNewProject, answerStartup } from '../../server.mjs';
import { liveSessions, closedSession, transcript } from '../../server/transcripts.mjs';

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

    // a chat idle at its prompt while its own background command runs is working until the task notice arrives
    const launched = [...turn,
        { type: 'user', sessionId: 's', entrypoint: 'cli', timestamp: at('55:31'), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'Command running in background with ID: bx1. Output is being written to: /tmp/bx1.output' }] } },
        { type: 'assistant', sessionId: 's', entrypoint: 'cli', timestamp: at('55:32'), message: { content: [{ type: 'text', text: 'Waiting for the tests.' }] } },
        { type: 'system', subtype: 'turn_duration', sessionId: 's', timestamp: at('55:33') }];
    const notice = { type: 'attachment', sessionId: 's', timestamp: at('59:00'), attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>bx1</task-id>\n<status>completed</status>\n</task-notification>' } };
    assert.equal(summarize(launched, 5 * 60_000, null, new Set(['s'])).status, 'working');
    assert.equal(summarize([...launched, notice, launched[3], launched[4]], 5 * 60_000, null, new Set(['s'])).status, 'waiting', 'its notice ends it');
    assert.equal(summarize(launched, 5 * 60_000, null, new Set()).status, 'waiting', 'a closed chat runs nothing');
    assert.equal(summarize(launched, 31 * 60_000, null, new Set(['s'])).status, 'idle', 'silent past the limit: a lost notice');
    console.log('ok background command keeps a chat working');
}

{
    // /api/transcript without dir or id, or with a path out of the projects folder, is a 400, not a 500
    for (const [dir, id] of [[null, 'x'], ['p', null], ['..', 'x'], ['a/b', 'x']]) {
        assert.equal((await transcript(dir, id).catch(e => e)).status, 400, `${dir} ${id}`);
    }
    console.log('ok transcript bad path');
}

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
    // an already trusted folder shows Claude's prompt with no dialog: it must not wait out waitMs (the route answers within the client's 15 s)
    let naps = 0;
    assert.equal(await trustNewProject('cc-new-x', '/base/league', { tm: async () => ({ stdout: '❯ Try "write a test"\n⏵⏵ auto mode on' }), nap: async () => { naps++; }, waitMs: 60_000 }), false);
    assert.equal(naps, 0, 'prompt up, no dialog: returns at once');
    const { refuseIfTrustDialog } = await import('../../server/startup.mjs');
    assert.equal((await refuseIfTrustDialog('cc-new-league', { tm: async () => ({ stdout: trust(0) }) }).catch(e => e)).status, 409, 'send refused while trust dialog is up');
    assert.equal(await refuseIfTrustDialog('cc-new-league', { tm: async () => ({ stdout: '❯ pick\nEnter to select' }) }), undefined, 'other dialogs (questions) still take sends');
    console.log('ok startup dialog');
}

// Restart chat: stubbed tmux, nothing real is touched
{
    const { restartChat, promptUp } = await import('../../server.mjs');
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
    const home = fake();
    await restartChat(sid, { ...home.opts, session: { ...session, cwd: '/w/.claude/worktrees/2263-x', home: '/w' } });
    assert.equal(home.calls[2][home.calls[2].indexOf('-c') + 1], '/w', "restarts in the chat's home, not where a cd left it");
    const stuck = fake(true, 'loading');
    assert.equal((await restartChat(sid, { ...stuck.opts, waitMs: 1000 }).catch(e => e)).status, 504);
    assert.deepEqual([promptUp('❯ '), promptUp('loading'), promptUp('Do you trust?\n\n❯ 1. Yes\n  2. No\nEnter to confirm')], [true, false, false]);
    // fresh conversation after a cd: a new Claude (no --resume) in the chat's home, same tmux name, instead of /clear
    const { clearChat } = await import('../../server/control.mjs');
    const moved = fake();
    await clearChat(sid, { ...moved.opts, session: { ...session, cwd: '/w/.claude/worktrees/2263-x', home: '/w' }, reg: async () => new Map() });
    const made = moved.calls.find(c => c[0] === 'new-session');
    assert.deepEqual(moved.calls.map(c => c[0]), ['kill-session', 'new-session']);
    assert.deepEqual([made[made.indexOf('-s') + 1], made[made.indexOf('-c') + 1], made.join(' ').includes('--resume')], ['cc-cccccccc', '/w', false]);
    console.log('ok restart chat');
}

{
    // Homebase's own "Load new rules" message typed after a reply that waits on you is not an answer: it still needs the user
    const { reloadMessage } = await import('../../server/rules.mjs');
    const reply = text => ({ type: 'assistant', uuid: 'r1', sessionId: 's', cwd: '/r', message: { content: [{ type: 'text', text }] } });
    const you = text => ({ type: 'user', message: { content: text } });
    const asked = [you('go'), reply('**▸ Deploy**\n\nWaiting on you: ship it? — 1. Yes — 2. No\n\nTLDR: ship it?')];
    assert.equal(summarize([...asked, you(reloadMessage())], 60_000).needsYou, true, 'a rules note');
    assert.equal(summarize([...asked, you('later')], 60_000).needsYou, false, 'a real message ends it');
    console.log('ok rules note keeps needs you');
}
