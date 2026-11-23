import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { summarize, chatItems } from '../../server.mjs';

{
    const { accountOf, readToken, ghRun, signedIn, me, repoOfUrl, sameRepo, workItems, mergeConfig } = await import('../../server.mjs');
    const personalCfg = { newProject: { owner: 'lommerusk113', keychainService: 'gh-personal', sshHost: 'github-personal' } };
    const cfg = mergeConfig(personalCfg);
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const hbDir = mkdtempSync(join(tmpdir(), 'hb-cfg-'));
    writeFileSync(join(hbDir, 'config.json'), JSON.stringify(personalCfg));
    process.env.HOMEBASE_DIR = hbDir; // ghRun reads the config file
    const TOKEN = 'ghp_PERSONAL_SECRET_456';

    // token selection: the alias host or the configured owner is personal; everything else, GitLab included, stays work
    const pick = (host, path) => accountOf({ host, path }, cfg);
    assert.equal(pick('github-personal', 'someoneelse/thing'), 'personal', 'alias host');
    assert.equal(pick('github.com', 'lommerusk113/tracker'), 'personal', 'owner match');
    assert.equal(pick('github.com', 'LommeruSK113/tracker'), 'personal', 'owner is case-insensitive');
    assert.equal(pick('github.com', 'acme/beta'), 'work');
    assert.equal(pick('gitlab.com', 'lommerusk113/tracker'), 'work', 'GitLab never uses the GitHub token');
    assert.equal(accountOf({ host: 'github.com', path: 'lommerusk113/x' }, null), 'work', 'no valid config: as today');

    // ghRun with stubbed exec: token only for personal repos, GITHUB_TOKEN removed, one keychain read, token scrubbed from errors
    process.env.GITHUB_TOKEN = 'work-token';
    const calls = [];
    const exec = (fail = false) => async (file, args, opts = {}) => {
        calls.push({ file, env: opts.env });
        if (file === 'security') {
            return { stdout: `${TOKEN}\n` };
        }
        if (fail) {
            throw Object.assign(new Error(`Command failed: gh ${args.join(' ')} ${TOKEN}`), { stderr: `bad credentials ${TOKEN}` });
        }
        return { stdout: '{}' };
    };
    // a failed keychain read is not cached, and the call still runs as today with the keychain error up front
    const k = await ghRun({ host: 'github.com', path: 'lommerusk113/other' }, ['api', 'x'], {}, async file => {
        throw new Error(file === 'security' ? 'denied' : 'HTTP 404');
    }).catch(e => e);
    assert.equal(k.message, 'could not read keychain item "gh-personal"; HTTP 404');
    await ghRun({ host: 'github.com', path: 'lommerusk113/tracker' }, ['api', 'user'], {}, exec());
    await ghRun({ host: 'github-personal', path: 'lommerusk113/tracker' }, ['api', 'user'], {}, exec());
    await ghRun({ host: 'github.com', path: 'acme/beta' }, ['api', 'user'], {}, exec());
    assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'gh', 'gh'], 'one keychain read for two personal calls');
    assert.equal(calls[1].env.GH_TOKEN, TOKEN);
    assert.equal('GITHUB_TOKEN' in calls[1].env, false);
    assert.equal(calls[3].env, undefined, 'work repo: env untouched');
    const err = await ghRun({ host: 'github.com', path: 'lommerusk113/tracker' }, ['api', 'x'], {}, exec(true)).catch(e => e);
    assert.ok(!JSON.stringify([err.message, err.stderr]).includes(TOKEN) && err.stderr.includes('[token]'), 'token scrubbed from errors');

    assert.equal(await readToken('svc-y', async () => ({ stdout: '\n' })).catch(e => e.message), 'could not read keychain item "svc-y"');

    // signedIn per account, with real child processes: fake gh and security first on PATH
    const bin = mkdtempSync(join(tmpdir(), 'hb-acct-'));
    const log = join(bin, 'log'), failFlag = join(bin, 'fail');
    writeFileSync(join(bin, 'security'), `#!/bin/sh\necho ${TOKEN}\n`, { mode: 0o755 });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "\${GH_TOKEN:-none}|\${GITHUB_TOKEN:-none}" >> "${log}"\n[ -e "${failFlag}" ] && { echo "boom ${TOKEN}" >&2; exit 1; }\n[ "\${GH_TOKEN:-}" = "${TOKEN}" ] && echo '{"login":"lommerusk113"}' || echo '{"login":"worker"}'\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
        const personal = { host: 'github-personal', path: 'lommerusk113/tracker' }, work = { host: 'github.com', path: 'acme/beta' };
        writeFileSync(failFlag, '');
        assert.equal(await signedIn(personal), null, 'a failed lookup is null...');
        assert.equal(await signedIn(work), null);
        assert.equal(me.size, 0, '...and not cached');
        rmSync(failFlag);
        assert.equal((await signedIn(personal)).username, 'lommerusk113');
        assert.equal((await signedIn(work)).username, 'worker', 'work account is its own entry');
        await signedIn(personal);
        await signedIn(work);
        const lines = readFileSync(log, 'utf8').trim().split('\n');
        assert.equal(lines.filter(l => l === `${TOKEN}|none`).length, 2, 'personal: asked again after the failure, then cached');
        assert.equal(lines.filter(l => l === 'none|work-token').length, 2, 'work: env untouched, asked again after the failure, then cached');
    } finally {
        process.env.PATH = path;
        delete process.env.GITHUB_TOKEN;
    }

    // a known repo's alias keeps its account when only the github.com URL is at hand
    const { repoPaths } = await import('../../server/account.mjs');
    repoPaths.set('tracker', { host: 'github-personal', path: 'lommerusk113/tracker' });
    assert.deepEqual(repoOfUrl('https://github.com/lommerusk113/tracker/pull/32'), { host: 'github-personal', path: 'lommerusk113/tracker' });
    assert.deepEqual(repoOfUrl('https://gitlab.com/a/b/-/merge_requests/3'), { host: 'gitlab.com', path: 'a/b' });
    repoPaths.delete('tracker');

    // another repo's MR in a session's pr-links or a store never lands under the project
    const url = 'https://github.com/lommerusk113/homebase/pull/2', own = 'https://github.com/lommerusk113/tracker/pull/32';
    assert.equal(sameRepo(url, 'tracker'), false);
    assert.equal(sameRepo(url, 'tracker', 'lommerusk113/tracker'), true, 'the pr-link\'s own prRepository wins');
    assert.equal(sameRepo(own, 'tracker', 'lommerusk113/homebase'), false);
    const items = workItems([{ id: 's', project: 'tracker', prs: [{ url, at: 1 }, { url: own, at: 2 }, { url: 'https://github.com/x/y/pull/1', at: 3, repo: 'lommerusk113/tracker' }], agents: [] }], () => null, 0, new Map());
    assert.deepEqual(items.map(i => i.pr).sort(), [own, 'https://github.com/x/y/pull/1'].sort());

    const { loadStore } = await import('../../server/store.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'hb-store-'));
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify({ tracker: { [url]: { state: 'open', lastSeen: Date.now() }, [own]: { state: 'open', lastSeen: Date.now() } } }));
    const st = loadStore(file);
    assert.deepEqual(Object.keys(st.data.tracker), [own], 'the misfiled entry is dropped on load');
    assert.equal(st.dirty, true);
    console.log('ok accounts and repo filtering');
}

{
    const { readTracked, saveTracked } = await import('../../server.mjs');
    const dir = join(mkdtempSync(join(tmpdir(), 'hb-tracked-')), 'homebase');
    assert.equal(await readTracked(dir), null, 'nothing saved yet');
    await saveTracked(dir, '["alpha","beta","alpha"]');
    assert.deepEqual(await readTracked(dir), ['alpha', 'beta']);
    await saveTracked(dir, '[]');
    assert.deepEqual(await readTracked(dir), [], 'an emptied board stays empty');
    for (const bad of ['nope', '{}', '[1]', '[""]', JSON.stringify(['x'.repeat(201)])]) {
        await assert.rejects(saveTracked(dir, bad), e => e.status === 400, bad);
    }
    assert.deepEqual(await readTracked(dir), []);
    console.log('ok tracked projects');
}

// a reply marked as handled no longer needs you; a newer needing reply does again; an open question is not dismissed
{
    const { loadHandled, markHandled } = await import('../../server/handled.mjs');
    const dir = join(mkdtempSync(join(tmpdir(), 'hb-handled-')), 'homebase');
    const sid = '11111111-1111-4111-8111-111111111111', r1 = '22222222-2222-4222-8222-222222222222', r2 = '33333333-3333-4333-8333-333333333333';
    const reply = (uuid, text) => ({ type: 'assistant', uuid, sessionId: sid, cwd: '/r', message: { content: [{ type: 'text', text }] } });
    const first = [{ type: 'user', message: { content: 'go' } }, reply(r1, '**▸ Deploy · needs you**\n\nTLDR: deploy later\n\n- Waiting on you: deploy when ready')];
    const before = summarize(first, 60_000);
    assert.deepEqual([before.needsYou, before.needsId, chatItems(first).at(-1).id], [true, r1, r1]);

    for (const [s, r] of [[sid, 'nope'], ['../x', r1], [sid, null], [null, r1], [sid, `${r1}/x`]]) {
        await assert.rejects(markHandled(dir, s, r), e => e.status === 400, `${s} ${r}`);
    }
    assert.equal(summarize(first, 60_000).needsYou, true, 'a refused id dismisses nothing');

    await markHandled(dir, sid, r1);
    const after = summarize(first, 60_000), item = chatItems(first).at(-1);
    assert.deepEqual([after.needsYou, after.needsId, after.needsText], [false, null, null]);
    assert.deepEqual([item.needsYou, item.waiting], [false, undefined], 'no pill and no pinned decision in the chat');

    const newer = [...first, { type: 'user', message: { content: '<task-notification>x</task-notification>' } }, reply(r2, '**▸ Deploy · needs you**\n\nTLDR: pick a port')];
    assert.deepEqual([summarize(newer, 60_000).needsYou, summarize(newer, 60_000).needsId], [true, r2], 'a newer reply that needs you shows again');

    const asking = summarize([...first, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which?' }] } }] } }], 60_000);
    assert.equal(asking.asking, true, 'an open question still asks');

    // saved: another server start reads it back; a broken file and the cap are handled
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'handled.json'), 'utf8')), [`${sid}/${r1}`]);
    writeFileSync(join(dir, 'handled.json'), 'nope');
    loadHandled(dir);
    assert.equal(summarize(first, 60_000).needsYou, true, 'nothing kept from a broken file');
    const hex = n => `${String(n).padStart(8, '0')}-2222-4222-8222-222222222222`;
    for (let n = 0; n < 501; n++) {
        await markHandled(dir, sid, hex(n));
    }
    const saved = JSON.parse(readFileSync(join(dir, 'handled.json'), 'utf8'));
    assert.deepEqual([saved.length, saved[0], saved.at(-1)], [500, `${sid}/${hex(1)}`, `${sid}/${hex(500)}`], 'the oldest goes first');
    loadHandled(join(dir, 'none'));
    console.log('ok handled replies');
}
