import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Send: stubbed tmux and registry, nothing real is touched
{
    const { send, withLock, tmuxFor, runningTwice, restartChat } = await import('../../server.mjs');
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
    await send(sid, 'hi', { ...session, asking: true }, { ...f.opts(new Map()), typed: true });
    assert.deepEqual(f.keys().slice(1), [['send-keys', '-t', '=cc-dddddddd:', 'Escape'], ...typed('cc-dddddddd', 'hi')]);
    // a question with Claude's own text box ("Type something."): typed text answers it there, the ❯ moved onto the box
    // first, no Esc. A slash command or several lines still decline and go in as a message
    const free = at => ['│ Which one?', '  1. Red', '  2. Blue', '  3. Type something.', '  4. Chat about this', 'Enter to select · Esc to cancel', '']
        .map((l, i) => (i === at + 1 ? l.replace('  ', '❯ ') : l)).join('\n');
    const freePanes = calls => (calls.some(c => c.at(-1) === 'Enter' || c.includes('Escape')) ? '❯ ' : free(calls.some(c => c.includes('Down')) ? 2 : 0));
    f = fake({ panes: freePanes });
    let how = null;
    await send(sid, 'Green', { ...session, asking: true }, { ...f.opts(new Map()), typed: true, answered: () => { how = 'answered'; } });
    assert.deepEqual(f.keys().slice(1), [['send-keys', '-t', '=cc-dddddddd:', 'Down', 'Down'], ...typed('cc-dddddddd', 'Green')]);
    assert.equal(how, 'answered');
    for (const text of ['/context', 'two\nlines']) {
        f = fake({ panes: freePanes });
        await send(sid, text, { ...session, asking: true }, { ...f.opts(new Map()), typed: true });
        assert.deepEqual(f.keys()[1], ['send-keys', '-t', '=cc-dddddddd:', 'Escape'], text);
    }
    // the box never takes the ❯, or the question stays up after Enter: an error, never typed blind
    f = fake({ panes: () => free(0) });
    assert.equal((await send(sid, 'Green', session, { ...f.opts(new Map()), typed: true }).catch(e => e)).status, 502);
    assert.ok(!f.keys().some(k => k.includes('-l')));
    f = fake({ panes: calls => free(calls.some(c => c.includes('Down')) ? 2 : 0) });
    assert.equal((await send(sid, 'Green', session, { ...f.opts(new Map()), typed: true }).catch(e => e)).status, 502);
    {
        // the input box counts only as the pane's last block, at column 0: printed text that looks like one (tool output,
        // tests/fixtures/pane-fake-input-box.txt, above a prompt questionOpen doesn't know) never lifts the refusal
        const { promptBack, freeTextOption } = await import('../../server/startup.mjs');
        const fx = n => readFileSync(new URL(`../fixtures/${n}.txt`, import.meta.url), 'utf8');
        const rule = '─'.repeat(20), box = `${rule}\n❯ \n${rule}\n`;
        assert.equal(promptBack(fx('pane-context')), true, 'the real idle pane');
        assert.equal(promptBack(fx('pane-fake-input-box')), false);
        assert.equal(promptBack(`${box}\n⏺ Done.\n\n Allow this?\n\n Press Enter to continue\n Second line\n Third line\n`), false, 'an old box further up');
        assert.equal(promptBack(`${box} Allow?\n ❯ 1. Yes\n   2. No\n`), false, 'a short dialog under an old box');
        assert.equal(promptBack(`  ${rule}\n  ❯ \n  ${rule}\n`), false, 'indented');
        assert.equal(promptBack(`${box}  ? for shortcuts\n`), true);
        f = fake({ panes: () => fx('pane-fake-input-box') });
        assert.equal((await send(sid, 'hi', { ...session, asking: true }, { ...f.opts(new Map()), typed: true }).catch(e => e)).status, 409);
        assert.ok(!f.keys().some(k => k[0] === 'send-keys'));
        // an option Claude itself labels "Type something" is not the text box: that is the last one
        assert.equal(freeTextOption('│ Which?\n❯ 1. Type something\n  2. Blue\n  3. Type something.\n  4. Chat about this\nEnter to select · Esc to cancel\n'), 2);
        // the ❯ left the text box while typing: no Enter. A tab in the line (it could switch question tabs) is typed as a space
        f = fake({ panes: calls => free(calls.some(c => c.includes('-l')) ? 1 : calls.some(c => c.includes('Down')) ? 2 : 0) });
        assert.equal((await send(sid, 'Green', session, { ...f.opts(new Map()), typed: true }).catch(e => e)).status, 409);
        assert.ok(!f.keys().some(k => k.at(-1) === 'Enter'));
        f = fake({ panes: freePanes });
        await send(sid, 'a\tb', session, { ...f.opts(new Map()), typed: true });
        assert.deepEqual(f.keys().find(k => k.includes('-l')).at(-1), 'a b');
    }
    // only what the user typed declines a question: a button's canned message (row action, Load rules) is refused, nothing pressed
    for (const asking of [true, false]) {
        f = fake({ panes: () => q });
        const refused = await send(sid, 'Fix the pipeline', { ...session, asking }, f.opts(new Map())).catch(e => e);
        assert.equal(refused.status, 409);
        assert.match(refused.message, /answer/i);
        assert.deepEqual(f.keys().slice(1), []);
    }
    // asking by a stale marker (a permission prompt approved, its tool still running): the input box is back, so it is typed
    f = fake({ panes: () => '✻ Working… (12s)\n\n──────────\n❯ \n──────────\n' });
    await send(sid, 'hi', { ...session, asking: true }, f.opts(new Map()));
    assert.deepEqual(f.keys().slice(1), typed('cc-dddddddd', 'hi'));
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

    // Claude is compacting (tests/fixtures/pane-compacting.txt): nothing is typed, neither a message (Claude would queue it
    // with no text in the transcript, so the page could never show it) nor a second /compact from another page
    const compacting = readFileSync(new URL('../fixtures/pane-compacting.txt', import.meta.url), 'utf8');
    for (const text of ['hi', '/compact']) {
        f = fake({ panes: () => compacting });
        assert.match((await send(sid, text, session, f.opts(new Map())).catch(e => e)).message, /compacting/i, text);
        assert.ok(!f.calls.some(c => c[0] === 'send-keys'), text);
    }

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

    // Slash commands: a panel (/usage, /status, /config, /help, /model…) is read, closed with Esc and shown; /exit and the like never typed
    const { panelText, commandOutput, settleCommand } = await import('../../server/control.mjs');
    const pane = c => readFileSync(new URL(`../fixtures/pane-${c}.txt`, import.meta.url), 'utf8');
    const prompt = '────\n❯ \n────\n  ⏵⏵ auto mode on\n';
    for (const [c, has] of [['usage', 'Total cost:'], ['status', 'Version:'], ['config', 'Auto-compact'], ['help', 'Shortcuts'], ['model', 'Select model']]) {
        const t = panelText(pane(c));
        assert.ok(t?.includes(has), c);
        assert.ok(!/Esc to|▔|↓$/m.test(t), `${c}: no footer, rule or scroll marker`);
        assert.ok(!/^\s/.test(t), `${c}: dedented`);
    }
    for (const p of [pane('context'), compacting, readFileSync(new URL('../fixtures/dialog-switch-model-footer.txt', import.meta.url), 'utf8'), prompt, '❯ ']) {
        assert.equal(panelText(p), null, 'no panel: the prompt, a compaction, or a question the card shows');
    }
    assert.match(commandOutput(pane('context'), '/context'), /^Context usage\n/);
    assert.ok(!commandOutput(pane('context'), '/context').includes('Update installed'), 'a right-aligned notice is not output');
    assert.equal(commandOutput(prompt, '/context'), null);

    const settle = async (panes, cmd) => {
        f = fake({ panes: () => (panes.length > 1 ? panes.shift() : panes[0]) });
        const r = await settleCommand('cc-dddddddd', cmd, { tm: f.opts().tm, nap: async () => {} });
        return { r, esc: f.keys().filter(k => k.at(-1) === 'Escape').length };
    };
    let s = await settle([`────\n❯ /usage\n────\n`, pane('usage'), pane('usage'), pane('usage'), prompt], '/usage');
    assert.match(s.r.text, /^Settings {2}Status/);
    assert.equal(s.r.pick, false);
    assert.equal(s.esc, 1, 'one Esc closes it');
    s = await settle([pane('config'), pane('config'), pane('config'), pane('config'), prompt], '/config');
    assert.equal(s.esc, 2, 'Esc again while it stays open (the first leaves its search box)');
    assert.equal(s.r.pick, true, 'a picker: pick in the terminal');
    s = await settle([pane('help')], '/help');
    assert.match(s.r.stuck, /Esc didn't close/);
    assert.equal(s.esc, 3, 'gives up after three');
    s = await settle([pane('context')], '/context');
    assert.deepEqual([s.r.text.split('\n')[0], s.esc], ['Context usage', 0], 'printed under the prompt: that output, nothing pressed');
    s = await settle([`❯ /context\n  · Imagining… (2s)\n${prompt}`, pane('context')], '/context');
    assert.equal(s.r.text.split('\n')[0], 'Context usage', 'its spinner first: waits for the output');
    s = await settle([compacting], '/compact');
    assert.deepEqual(s, { r: null, esc: 0 }, 'busy (compacting): nothing pressed');

    // a panel left open (by an earlier send or in the terminal) is closed before typing; one that won't close refuses the send
    f = fake({ panes: calls => (calls.some(c => c.at(-1) === 'Escape') ? '❯ ' : pane('usage')) });
    await send(sid, 'hi', session, f.opts(new Map()));
    assert.deepEqual(f.keys().slice(1), [['send-keys', '-t', '=cc-dddddddd:', 'Escape'], ...typed('cc-dddddddd', 'hi')]);
    f = fake({ panes: () => pane('usage') });
    const stuck = await send(sid, 'hi', session, f.opts(new Map())).catch(e => e);
    assert.equal(stuck.status, 409);
    assert.match(stuck.message, /panel.*Stop/);
    assert.ok(!f.keys().some(k => k.includes('-l')), 'nothing typed into it');
    for (const text of ['/exit', '/quit', ' /login', '/logout']) {
        f = fake();
        const e = await send(sid, text, session, f.opts(new Map())).catch(e => e);
        assert.equal(e.status, 409, text);
        assert.equal(f.calls.length, 0, `${text}: nothing touched`);
    }
    console.log('ok slash commands');
}

// Row button double-send guard (once=<rowKey>): a repeat is refused until the kind changes or 120 s pass
{
    const { claim, release, ONCE_MS } = await import('../../server/once.mjs');
    const m = new Map();
    assert.equal(claim(m, 'k', 'stopped', 0), true, 'first send');
    assert.equal(claim(m, 'k', 'stopped', 1000), false, 'repeat, same kind');
    assert.equal(claim(m, 'other', 'stopped', 1000), true, 'another row');
    assert.equal(claim(m, 'k', 'blocked', 2000), true, 'kind changed');
    assert.equal(claim(m, 'k', 'blocked', 2000 + ONCE_MS - 1), false);
    assert.equal(claim(m, 'k', 'blocked', 2000 + ONCE_MS), true, 'after 120 s');
    release(m, 'k');
    assert.equal(claim(m, 'k', 'blocked', 2000 + ONCE_MS + 1), true, 'a failed send is retried with the same key');
    console.log('ok send once guard');
}
