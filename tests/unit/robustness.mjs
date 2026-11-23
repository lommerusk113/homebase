import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { summarize } from '../../server.mjs';

// One odd entry in one transcript never takes /api/sessions or that chat's feed down: the entry is skipped, and a
// session that still can't be read is left out and logged once per file and size, not per poll.
{
    const home = mkdtempSync(join(tmpdir(), 'hb-odd-'));
    const dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const line = e => JSON.stringify({ timestamp: at, ...e }) + '\n';
    const tool = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
    writeFileSync(join(dir, 'good.jsonl'), line({ type: 'user', sessionId: 'good', message: { content: 'hi' } }));
    writeFileSync(join(dir, 'odd.jsonl'), ['null\n', '7\n', '[1]\n',
        line({ type: 'user', sessionId: 'odd', cwd: 42, message: { content: [null, { type: 'text', text: 'hello' }] } }),
        line({ type: 'user', sessionId: { a: 1 }, message: { content: 'x' } }),
        line({ type: 'pr-link', prUrl: 7 }),
        line(tool('Edit', { file_path: 7 })),
        line(tool('Bash', { command: 7 })),
        line(tool('AskUserQuestion', { questions: 'which?' })),
        line(tool('AskUserQuestion', { questions: [null, { question: 7, options: 'a' }] })),
        line({ type: 'assistant', message: { content: [null, { type: 'text', text: 'answer' }] } })
    ].join(''));
    const code = `import { sessions } from './server/sessions.mjs'; import { feedTail } from './server/transcripts.mjs'; import { statSync } from 'node:fs';
        const ids = (await sessions()).map(s => s.id).sort(); await sessions();
        const path = ${JSON.stringify(join(dir, 'odd.jsonl'))};
        const feed = await feedTail(path, statSync(path));
        console.log(JSON.stringify({ ids, texts: feed.items.map(i => i.text) }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    assert.deepEqual(out.ids, ['good', 'odd'], 'both sessions are listed');
    assert.ok(out.texts.includes('answer'), 'the odd chat still shows its replies');
    rmSync(home, { recursive: true, force: true });

    // a session that fails anyway is left out, the rest listed, and the file logged once per size
    const { tolerant } = await import('../../server/sessions.mjs');
    const logged = [];
    const read = tolerant(async t => {
        if (t.path === 'bad') {
            throw new Error('boom');
        }
        return { id: t.path };
    }, m => logged.push(m));
    assert.deepEqual([await read({ path: 'ok', st: { size: 1 } }), await read({ path: 'bad', st: { size: 1 } }), await read({ path: 'bad', st: { size: 1 } })], [{ id: 'ok' }, null, null]);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /bad.*boom/);
    await read({ path: 'bad', st: { size: 2 } });
    assert.equal(logged.length, 2, 'logged again once the file changed size');
    console.log('ok odd transcript entries');
}

// First run: with no ~/.claude/projects folder (Claude Code never ran) there are no chats and no log, not an error.
{
    const home = mkdtempSync(join(tmpdir(), 'hb-fresh-'));
    const code = "import { sessions, startingChats } from './server/sessions.mjs'; import { log } from './server/log.mjs'; await log('p'); console.log(JSON.stringify([await sessions(), await startingChats()]));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, HOMEBASE_DIR: home, HOMEBASE_TMUX_SOCKET: 'homebase-test-none' }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), [[], []]);
    rmSync(home, { recursive: true, force: true });
    console.log('ok no projects folder');
}

// A config.json that is no JSON (truncated, empty, a folder) is set aside like a corrupt items.json: defaults apply,
// one log line says so, and doctor reports it.
{
    const { readConfigFile, loadConfig, DEFAULTS: NEW_PROJECT_DEFAULTS } = await import('../../server/account.mjs');
    const { doctor } = await import('../../server/setup.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hb-config-')), file = join(dir, 'config.json');
    const settings = join(dir, 'settings.json');
    const warns = () => doctor('/opt/hb', settings, null, file).lines.filter(l => l.includes('config.json'));
    assert.deepEqual(warns(), [], 'no config: nothing to say');
    const logged = [], error = console.error;
    console.error = m => logged.push(m);
    try {
        for (const make of [() => writeFileSync(file, '{"newProject": {"own'), () => writeFileSync(file, ''), () => mkdirSync(file)]) {
            make();
            assert.equal(warns().length, 1, 'doctor sees a config it cannot read');
            assert.equal(readConfigFile(file), undefined);
            assert.equal(loadConfig(file).sshHost, NEW_PROJECT_DEFAULTS.sshHost, 'defaults apply');
            assert.throws(() => statSync(file), 'the bad file is moved away');
            statSync(`${file}.bak`);
            assert.equal(warns().length, 1, 'doctor still says a config was set aside');
            rmSync(`${file}.bak`, { recursive: true });
        }
    } finally {
        console.error = error;
    }
    assert.equal(logged.length, 3, 'one line per bad file');
    assert.ok(logged.every(l => l.includes(`${file}.bak`)));
    rmSync(dir, { recursive: true, force: true });
    console.log('ok corrupt config.json');
}

// A turn that never ended and that nothing works on any more (silent past the stale limit, or its process gone) is
// reported as died, so the board can keep a row for it; a finished or running turn is not.
{
    const { turnState } = await import('../../server/transcripts.mjs');
    const at = s => `2026-11-13T09:${s}.000Z`;
    const open = [
        { type: 'user', sessionId: 's', entrypoint: 'cli', cwd: '/r', uuid: 'p', timestamp: at('55:20'), origin: { kind: 'human' }, promptSource: 'typed', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'fix it' } },
        { type: 'assistant', sessionId: 's', entrypoint: 'cli', uuid: 'a', timestamp: at('55:30'), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use' } }
    ];
    const ended = [...open, { type: 'system', subtype: 'turn_duration', timestamp: at('56:00') }];
    const min = 60_000, running = new Set(['s']), gone = new Set(['other']);
    assert.equal(!!turnState(open, 20 * min).died, false, 'still within the limit: working');
    for (const age of [31 * min, 61 * min, 9 * 60 * min]) {
        assert.equal(turnState(open, age).died, true);
        assert.equal(turnState(open, age, null, running).died, true, 'the process lives but wrote nothing');
        assert.equal(!!turnState(open, age, null, gone).died, false, 'the process is gone: closed on purpose or not, it cannot be told, so no row');
        assert.equal(summarize(open, age).died, true, 'the session says so');
        assert.equal(!!turnState(ended, age).died, false);
        assert.equal(!!turnState(ended, age, null, gone).died, false, 'closed after its turn ended');
        assert.equal(!!summarize(ended, age).died, false);
    }
    assert.equal(!!turnState(open, 31 * min, null, Object.assign(new Set(['s']), { busy: new Set(['s']) })).died, false, 'a long tool call of a busy process');
    console.log('ok died turn');
}

// A chat that still waits on the user stays listed past the 3-day window (up to 14 days); a settled one of that age does not.
{
    const home = mkdtempSync(join(tmpdir(), 'hb-aged-'));
    const dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const day = 864e5, now = Date.now();
    const chat = (id, days, reply) => {
        const at = s => new Date(now - days * day + s * 1000).toISOString();
        writeFileSync(join(dir, `${id}.jsonl`), [
            { type: 'user', sessionId: id, cwd: '/r', uuid: 'p', timestamp: at(0), turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'go' } },
            { type: 'assistant', sessionId: id, uuid: 'a', timestamp: at(1), message: { content: [{ type: 'text', text: reply }] } },
            { type: 'system', subtype: 'turn_duration', timestamp: at(2) }
        ].map(e => JSON.stringify(e)).join('\n') + '\n');
        utimesSync(join(dir, `${id}.jsonl`), new Date(now - days * day), new Date(now - days * day));
    };
    const asks = '**▸ Pick a port** · needs you\n\nWhich port should it use?', done = '**▸ Tidied**\n\nAll done.';
    chat('fresh-done', 1, done);
    chat('old-asks', 4, asks);
    chat('old-done', 4, done);
    chat('ancient-asks', 20, asks);
    const code = "import { sessions } from './server/sessions.mjs'; await sessions(); console.log(JSON.stringify((await sessions()).map(s => [s.id, s.needsYou]).sort()));";
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, HOMEBASE_DIR: home, HOMEBASE_TMUX_SOCKET: 'homebase-test-none' }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), [['fresh-done', false], ['old-asks', true]]);
    rmSync(home, { recursive: true, force: true });
    console.log('ok aged chat that needs you');
}

// "Show earlier" at the read limit: the feed says its history was cut there (capped), instead of ending as if that were the start.
{
    const { feedTail } = await import('../../server/transcripts.mjs');
    const f = join(mkdtempSync(join(tmpdir(), 'hb-')), 'capped.jsonl');
    const pad = 'x'.repeat(4000);
    const rows = Array.from({ length: 400 }, (_, n) => [
        { type: 'user', timestamp: new Date(1e12 + n * 120_000).toISOString(), message: { content: `ask ${n}` } },
        { type: 'assistant', timestamp: new Date(1e12 + n * 120_000 + 1000).toISOString(), pad, message: { content: [{ type: 'text', text: `reply ${n}` }] } },
        { type: 'system', subtype: 'turn_duration', turnPosition: { n } }
    ]).flat();
    writeFileSync(f, rows.map(l => JSON.stringify(l)).join('\n') + '\n');
    const st = statSync(f);
    const few = await feedTail(f, st, 60, 1024 * 1024);
    assert.deepEqual([few.more, !!few.capped], [true, false], 'more to show first');
    const cut = await feedTail(f, st, 10_000, 1024 * 1024);
    assert.ok(cut.items.length < 800 && cut.items[0].text !== 'ask 0', 'the read stops at the limit');
    assert.deepEqual([cut.more, cut.capped], [false, true]);
    const all = await feedTail(f, st, 10_000);
    assert.deepEqual([all.items[0].text, all.more, !!all.capped], ['ask 0', false, false], 'a chat read to its start is not capped');
    console.log('ok show earlier at the read limit');
}

// Broken data files: a truncated handled.json or tracked.json is set aside with a log line (not silently reset), and
// an items.json with odd entries loads without them instead of leaving data that fails every later poll.
{
    const { loadStore, record, seeds } = await import('../../server/store.mjs');
    const { loadHandled } = await import('../../server/handled.mjs');
    const { readTracked } = await import('../../server/tracked.mjs');
    const { handled } = await import('../../server/transcripts.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hb-broken-'));
    const logged = [], error = console.error;
    console.error = m => logged.push(m);
    try {
        const url = 'https://gitlab.com/x/beta/-/merge_requests/1';
        writeFileSync(join(dir, 'items.json'), JSON.stringify({ alpha: null, gamma: 7, beta: { [url]: { state: 'open', lastSeen: Date.now(), sessionId: 's' }, 'https://gitlab.com/x/beta/-/merge_requests/2': null } }));
        const st = loadStore(join(dir, 'items.json'));
        assert.deepEqual(seeds(st, Date.now(), 864e5).map(s => s.url), [url], 'the good entry survives');
        record(st, []);
        assert.deepEqual(Object.keys(st.data), ['beta']);

        writeFileSync(join(dir, 'handled.json'), '["aaaaaaaa-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-0000000');
        loadHandled(dir);
        assert.equal(handled.size, 0);
        assert.ok(readFileSync(join(dir, 'handled.json.bak'), 'utf8').startsWith('["aaaa'), 'the broken file is kept aside');
        writeFileSync(join(dir, 'tracked.json'), '["alpha", "be');
        assert.equal(await readTracked(dir), null);
        assert.ok(readFileSync(join(dir, 'tracked.json.bak'), 'utf8').startsWith('["alpha'));
        assert.deepEqual(['handled.json', 'tracked.json'].map(f => logged.filter(l => l.includes(f)).length), [1, 1], 'one log line each');
        loadHandled(dir);
        assert.equal(await readTracked(dir), null);
        assert.equal(logged.filter(l => /handled|tracked/.test(l)).length, 2, 'a missing file is not an error');
    } finally {
        console.error = error;
    }
    rmSync(dir, { recursive: true, force: true });
    console.log('ok broken data files');
}

// A page whose clock is off from the server's (a phone, a manual change) counts ages on the server's clock, taken from
// the poll's Date header; a difference under a minute is network and rounding, and no header means no correction.
{
    const { ago, syncClock, chatStatus } = await import('../../public/core.js');
    const hour = 3600_000, twoMinAgo = off => Date.now() + off - 125_000;
    for (const off of [-hour, hour]) { // the server an hour behind the page, and an hour ahead
        syncClock(new Date(Date.now() + off).toUTCString());
        assert.match(ago(twoMinAgo(off)), /^2/, `2 minutes on the server's clock, with the page ${off < 0 ? 'ahead' : 'behind'}`);
        assert.match(chatStatus({ working: true, since: twoMinAgo(off), items: [] }).text, /2m/);
    }
    syncClock(new Date(Date.now() + 20_000).toUTCString());
    assert.equal(ago(Date.now() - 30_000), ago(Date.now() - 31_000), 'a few seconds are not skew');
    assert.doesNotMatch(ago(Date.now() - 50_000), /\d/);
    syncClock(new Date(Date.now() + hour).toUTCString());
    syncClock(null);
    assert.match(ago(Date.now() - 125_000), /^2/, 'no Date header: the page clock');
    console.log('ok clock skew');
}

// Died rows have a baseline: the first run with the feature notes "died rows start at" in the Homebase dir, and only a
// turn whose last activity is later is flagged, so chats that died before never flood the board.
{
    const { diedSince } = await import('../../server/sessions.mjs');
    const hb = mkdtempSync(join(tmpdir(), 'hb-died-')), file = join(hb, 'sub', 'died-since.json');
    assert.equal(diedSince(file, 1000), 1000, 'first run: now, written');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')), 1000);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(diedSince(file, 5000), 1000, 'later runs keep the first');
    writeFileSync(file, '{"trunc');
    assert.equal(diedSince(file, 7000), 7000, 'an unreadable note starts over rather than flag old turns');
    assert.equal(diedSince(file, 9000), 7000);

    // through the session list: the same 40-minute-silent open turn is flagged only when it is newer than the baseline
    const home = mkdtempSync(join(tmpdir(), 'hb-died-home-')), dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const min = 60_000, then = Date.now() - 40 * min, at = s => new Date(then + s * 1000).toISOString();
    writeFileSync(join(dir, 'silent.jsonl'), [
        { type: 'user', sessionId: 'silent', cwd: '/r', uuid: 'p', timestamp: at(0), turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'go' } },
        { type: 'assistant', sessionId: 'silent', uuid: 'a', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test' } }] } }
    ].map(e => JSON.stringify(e)).join('\n') + '\n');
    utimesSync(join(dir, 'silent.jsonl'), new Date(then), new Date(then));
    const code = "import { sessions } from './server/sessions.mjs'; console.log(JSON.stringify((await sessions()).map(s => [s.id, s.died])));";
    const run = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, HOMEBASE_DIR: hb, HOMEBASE_TMUX_SOCKET: 'homebase-test-none' }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' }));
    assert.deepEqual(run(), [['silent', false]], 'it died before the feature first ran');
    assert.ok(JSON.parse(readFileSync(join(hb, 'died-since.json'), 'utf8')) > then, 'that run wrote the baseline');
    writeFileSync(join(hb, 'died-since.json'), JSON.stringify(then - 60 * min));
    assert.deepEqual(run(), [['silent', true]], 'it died after the baseline');
    rmSync(hb, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    console.log('ok died baseline');
}

// a /clear-ed chat's rows move to its successor, through a chain of clears
{
    const { followClears } = await import('../../server/sessions.mjs');
    const items = [{ sessionId: 'a' }, { sessionId: 'x' }];
    followClears(items, [{ id: 'a' }, { id: 'b', clearedFrom: 'a' }, { id: 'c', clearedFrom: 'b' }, { id: 'x' }]);
    assert.deepEqual(items.map(i => i.sessionId), ['c', 'x']);
    console.log('ok follow clears');
}
