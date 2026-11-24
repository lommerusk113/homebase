import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { merge, unmerge, otherRoots, setup, unsetup, settingsPath, wanted } from '../../server/setup.mjs';

{
    const root = '/opt/hb';
    const mine = { type: 'command', command: 'echo mine' };
    const existing = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }], SessionStart: [{ hooks: [mine] }] }, statusLine: { type: 'command', command: '/my/line.sh' } };
    const m = merge(existing, root);
    assert.deepEqual(m.added, ['hook PreToolUse', 'hook PostToolUse', 'hook Notification', 'hook UserPromptSubmit', 'hook Stop'], 'adds all five hooks, no statusline over a different one');
    assert.deepEqual(m.conflict, existing.statusLine);
    assert.equal(m.settings.model, 'opus');
    assert.deepEqual(m.settings.hooks.SessionStart, existing.hooks.SessionStart);
    assert.deepEqual(m.settings.hooks.Stop, [{ hooks: [mine] }, wanted(root).hooks.Stop], 'existing hook stays, ours is appended');
    assert.deepEqual(existing.hooks.Stop, [{ hooks: [mine] }], 'input is not mutated');
    assert.deepEqual(merge(m.settings, root).added, [], 'idempotent');
    assert.equal(merge({}, root).added.at(-1), 'statusLine');

    const dir = mkdtempSync(join(tmpdir(), 'setup-'));
    const file = join(dir, 'settings.json');
    const old = process.env.HOMEBASE_CLAUDE_SETTINGS;
    process.env.HOMEBASE_CLAUDE_SETTINGS = file;
    assert.equal(settingsPath(), file, 'env override');
    const quiet = console.log;
    console.log = () => {};
    try {
        writeFileSync(file, JSON.stringify(existing));
        assert.match(await setup(root, file, async () => false), /Aborted/);
        assert.equal(readFileSync(file, 'utf8'), JSON.stringify(existing), 'declining writes nothing');
        assert.match(await setup(root, file, async q => !/Replace/.test(q)), /^Done, backup at /);
        const after = JSON.parse(readFileSync(file, 'utf8'));
        assert.deepEqual(after.statusLine, existing.statusLine, 'different statusline kept unless asked');
        assert.equal(after.hooks.Stop.length, 2);
        const backups = readdirSync(dir).filter(f => f.endsWith('.bak'));
        assert.equal(backups.length, 1);
        assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), JSON.stringify(existing), 'backup is the old file');
        assert.match(await setup(root, file, async () => false), /Nothing to do/, 'idempotent');
        assert.match(await setup(root, file, async () => true), /Done/, 'replacing the statusline when asked');
        assert.equal(JSON.parse(readFileSync(file, 'utf8')).statusLine.command, wanted(root).statusLine.command);
    } finally {
        console.log = quiet;
        if (old === undefined) {
            delete process.env.HOMEBASE_CLAUDE_SETTINGS;
        } else {
            process.env.HOMEBASE_CLAUDE_SETTINGS = old;
        }
    }
    console.log('ok setup merge');
}
{
    // the installed Claude Code against the version the parsing was checked with
    const { VERIFIED_CLAUDE, readClaudeVersion, versionWarning, doctor } = await import('../../server/setup.mjs');
    const [major, minor, patch] = VERIFIED_CLAUDE.split('.').map(Number);
    const newer = `${major}.${minor}.${patch + 1}`;
    assert.equal(versionWarning(), '', 'nothing read yet: no warning');
    assert.equal(readClaudeVersion(() => `rc file noise 9.9.9\n${newer} (Claude Code)\n`), newer, 'only the Claude Code line counts');
    assert.match(versionWarning(), new RegExp(`${newer} is newer than ${VERIFIED_CLAUDE}`), 'the read version is cached');
    assert.equal(readClaudeVersion(() => { throw new Error('no claude'); }), null);
    assert.equal(versionWarning(), '');
    assert.equal(versionWarning(VERIFIED_CLAUDE), '');
    assert.equal(versionWarning(`${major}.${minor}.${patch - 1}`), '', 'older is fine');
    assert.equal(versionWarning(`${major}.${minor - 1}.${patch * 10}`), '', 'compared as numbers, part by part');
    assert.notEqual(versionWarning(`${major}.${minor + 9}.0`), '');
    const file = join(mkdtempSync(join(tmpdir(), 'doctor-')), 'settings.json');
    assert.ok(doctor('/opt/hb', file, newer, `${file}.config`).lines.some(l => l.startsWith('warning ') && l.includes(newer)), '--doctor prints it');
    assert.ok(!doctor('/opt/hb', file, VERIFIED_CLAUDE, `${file}.config`).lines.some(l => l.startsWith('warning ')));
    console.log('ok claude version');
}
{
    // polls share one in-flight build and reuse a result younger than the ttl
    const { shared } = await import('../../server/sessions.mjs');
    let builds = 0, clock = 0, release, fail = false;
    const build = () => new Promise((resolve, reject) => {
        const n = ++builds;
        release = () => (fail ? reject(new Error('boom')) : resolve(n));
    });
    const get = shared(build, 1000, () => clock);
    // stale(): a build begun before it is neither reused nor cached
    {
        const old = get();
        const oldRelease = release;
        get.stale();
        const fresh = get();
        assert.equal(builds, 2, 'stale() starts a fresh build');
        oldRelease();
        release();
        assert.deepEqual([await old, await fresh], [1, 2]);
        assert.equal(await get(), 2, 'the old build did not take the cache');
        get.stale();
        builds = 0;
    }
    const [a, b] = [get(), get()];
    release();
    assert.deepEqual(await Promise.all([a, b]), [1, 1], 'concurrent callers share one build');
    clock = 999;
    assert.equal(await get(), 1, 'a fresh result is reused');
    assert.equal(builds, 1);
    clock = 1000;
    const c = get();
    clock = 5000; // a slow build: its age counts from when it finished
    release();
    assert.equal(await c, 2);
    clock = 5999;
    assert.equal(await get(), 2);
    clock = 6000;
    fail = true;
    const [d, e] = [get(), get()];
    release();
    await assert.rejects(d, /boom/);
    await assert.rejects(e, /boom/);
    fail = false;
    const f = get();
    release();
    assert.equal(await f, 4, 'a failed build is not kept');
    console.log('ok shared sessions build');
}

// The quoted path, the older unquoted form, and --unsetup
{
    const root = '/opt/hb', spaced = '/opt/my hb';
    const mine = { type: 'command', command: 'echo mine' };
    const old = r => ({
        hooks: Object.fromEntries(Object.entries(wanted(r).hooks).map(([event, e]) => [event, [{ ...e, hooks: [{ ...e.hooks[0], command: `node ${r}/hooks/asking.mjs` }] }]])),
        statusLine: { type: 'command', command: `${r}/scripts/statusline.sh` }
    });
    assert.notEqual(wanted(spaced).hooks.Stop.hooks[0].command, `node ${spaced}/hooks/asking.mjs`, 'the path is quoted');
    assert.deepEqual(merge(old(root), root).added, [], 'the unquoted form of an earlier setup counts as present');
    assert.equal(merge(old(root), root).conflict, null);
    assert.deepEqual(merge(merge({}, spaced).settings, spaced).added, [], 'quoted form is recognised, also with a space');
    const fixed = merge(old(spaced), spaced);
    assert.equal(fixed.added.length, 6, 'unquoted under a path with a space does not work, so it is replaced');
    assert.deepEqual(fixed.settings, merge({}, spaced).settings, 'replaced, not doubled');
    const quoteInPath = '/opt/it\'s';
    assert.deepEqual(unmerge(merge({}, quoteInPath).settings, quoteInPath).settings, {}, 'a quote in the path round-trips');

    const theirs = { model: 'opus', hooks: { Stop: [{ hooks: [mine] }], SessionStart: [{ hooks: [mine] }] } };
    const both = merge(theirs, root).settings;
    const un = unmerge(both, root);
    assert.deepEqual(un.settings, theirs, 'unmerge is the reverse of merge: only its own entries go');
    assert.equal(un.removed.length, 6);
    assert.deepEqual(unmerge(old(root), root).settings, {}, 'the unquoted form is removed too, and empty hooks leave no key');
    assert.deepEqual(unmerge(un.settings, root).removed, [], 'idempotent');
    assert.deepEqual(unmerge(merge({}, '/other/hb').settings, root).removed, [], 'another checkout\'s entries stay');
    const shared = { hooks: { Stop: [{ hooks: [mine, wanted(root).hooks.Stop.hooks[0]] }] }, statusLine: { type: 'command', command: '/my/line.sh' } };
    assert.deepEqual(unmerge(shared, root).settings, { hooks: { Stop: [{ hooks: [mine] }] }, statusLine: shared.statusLine }, 'a shared entry keeps the other hook; a foreign statusline stays');
    assert.deepEqual(otherRoots(merge(merge(theirs, root).settings, '/other/hb').settings, root), ['/other/hb']);
    assert.deepEqual(otherRoots(both, root), []);

    const dir = mkdtempSync(join(tmpdir(), 'unsetup-'));
    const file = join(dir, 'settings.json');
    const quiet = console.log;
    console.log = () => {};
    try {
        const before = JSON.stringify(both);
        writeFileSync(file, before);
        await unsetup(root, file, async () => false);
        assert.equal(readFileSync(file, 'utf8'), before, 'declining writes nothing');
        await unsetup(root, file, async () => true);
        assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), theirs);
        const backups = readdirSync(dir).filter(f => f.endsWith('.bak'));
        assert.equal(backups.length, 1);
        assert.equal(readFileSync(join(dir, backups[0]), 'utf8'), before, 'backup is the old file');
        await unsetup(root, file, async () => assert.fail('nothing to ask the second time'));
        assert.equal(readdirSync(dir).length, 2, 'idempotent: no second write or backup');
        await unsetup(root, join(dir, 'none.json'), async () => assert.fail('no file, nothing to ask'));
        assert.equal(readdirSync(dir).length, 2, 'a missing file is not created');
    } finally {
        console.log = quiet;
        rmSync(dir, { recursive: true, force: true });
    }
    console.log('ok unsetup');
}

// `node server.mjs --demo`: its own server on a free port over fixture data, refusing sends, gone with its temp dir on exit
{
    const demo = spawn(process.execPath, ['server.mjs', '--demo'], { cwd: join(import.meta.dirname, '../..'), stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    demo.stdout.on('data', d => { out += d; });
    try {
        for (let i = 0; i < 100 && !/Homebase on http/.test(out); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        const base = out.match(/Homebase on (http:\/\/localhost:\d+)/)[1], dir = out.match(/removes (\S+)/)[1];
        assert.notEqual(base, 'http://localhost:4321');
        const html = await (await fetch(base)).text();
        assert.doesNotMatch(html, /data-demo hidden/, 'the Demo marker shows');
        const headers = { 'x-homebase-token': html.match(/homebase-token" content="(\w+)"/)[1], 'x-codetool': '1' };
        const list = await (await fetch(`${base}/api/sessions`, { headers })).json();
        assert.ok(list.some(x => x.project === 'alpha' && x.cwd.startsWith(dir)), 'the board is the fixture\'s');
        const sent = await fetch(`${base}/api/send?id=${list[0].id}`, { method: 'POST', headers, body: 'hi' });
        assert.deepEqual([sent.status, /demo/.test(await sent.text())], [409, true], 'a send is refused with the reason');
        assert.equal((await fetch(`${base}/api/handled?id=${list[0].id}&reply=${list[0].id}`, { method: 'POST', headers })).status, 409, 'so is marking a reply as handled');
        demo.kill('SIGTERM');
        await new Promise(r => demo.once('exit', r));
        assert.throws(() => statSync(dir), 'the temp dir is removed');
    } finally {
        demo.kill('SIGKILL');
    }
    console.log('ok demo mode');
}

// Marker, statusline and log files hold question text and status JSON: owner-only, like the rest of the Homebase dir.
{
    const { ownerOnly } = await import('../../server/security.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hb-modes-')), mode = p => (statSync(join(dir, p)).mode & 0o777).toString(8);
    const env = { ...process.env, HOMEBASE_DIR: join(dir, 'new') }, id = '5010a555-e1b1-4472-afa4-c92b1b2f1882';
    execFileSync(process.execPath, ['hooks/asking.mjs'], { input: JSON.stringify({ session_id: id, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'm' }), env });
    execFileSync('scripts/statusline.sh', { input: JSON.stringify({ session_id: id }), env });
    assert.deepEqual(
        ['new', 'new/asking', `new/asking/${id}.json`, 'new/statusline', `new/statusline/${id}.json`].map(mode),
        ['700', '700', '600', '700', '600'], 'the hook and the statusline script create owner-only');

    // what an earlier version left behind is tightened at start
    for (const sub of ['asking', 'statusline']) {
        mkdirSync(join(dir, 'old', sub), { recursive: true, mode: 0o755 });
        writeFileSync(join(dir, 'old', sub, 'a.json'), '{}', { mode: 0o644 });
    }
    writeFileSync(join(dir, 'old', 'server.log'), '', { mode: 0o644 });
    ownerOnly(join(dir, 'old'));
    assert.deepEqual(
        ['old', 'old/asking', 'old/asking/a.json', 'old/statusline', 'old/statusline/a.json', 'old/server.log'].map(mode),
        ['700', '700', '600', '700', '600', '600']);
    ownerOnly(join(dir, 'missing')); // first start: nothing there yet
    rmSync(dir, { recursive: true });
    console.log('ok file modes');
}
