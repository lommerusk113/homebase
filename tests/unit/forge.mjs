import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { column, nextStep, rowAction } from '../../server.mjs';
import { prState, prs } from '../../server/forge.mjs';
import { mr, fakeBin, withFakeGlab, glabMr } from './helpers.mjs';

{
    // a hung glab can't hold the first /api/sessions load: the MR lookup times out like every other forge call
    process.env.HOMEBASE_API_TIMEOUT_MS = '300';
    const t0 = Date.now();
    const value = await withFakeGlab('sleep 5', () => prState('https://gitlab.example.com/g/hung/-/merge_requests/1'));
    assert.equal(value, null);
    assert.ok(Date.now() - t0 < 3000, `waited ${Date.now() - t0} ms`);
    delete process.env.HOMEBASE_API_TIMEOUT_MS;
    console.log('ok fetchPr timeout');
}

{
    // ready means merge now: a failing or running pipeline GitLab doesn't require still blocks it
    const failed = await glabMr({ head_pipeline: { status: 'failed' } }, 101);
    assert.deepEqual([failed.ready, failed.ci], [false, 'failing']);
    assert.equal(column('idle', failed, true), 'needs-you'); // Fix pipeline is on you
    assert.equal((await glabMr({ head_pipeline: { status: 'running' } }, 102)).ready, false);
    assert.equal((await glabMr({ head_pipeline: { status: 'success' } }, 103)).ready, true);
    console.log('ok ready vs ci');

    // merge statuses besides review and CI say what blocks the MR instead of "Waiting for review"
    const conflict = await glabMr({ detailed_merge_status: 'conflict', reviewers: [{ name: 'Ann' }] }, 111);
    assert.deepEqual([conflict.ready, conflict.blocked, nextStep(conflict, null), rowAction(mr(4), conflict, null, 'T').label], [false, 'conflict', 'Merge conflicts — rebase it', 'Rebase']);
    assert.equal(nextStep(await glabMr({ detailed_merge_status: 'blocked_status' }, 112), null), 'Blocked by another MR');
    // a must-pass project without a pipeline isn't "Pipeline failing"
    assert.equal((await glabMr({ detailed_merge_status: 'ci_must_pass' }, 113)).ci, null);
    // unchecked/checking keep the last answer, so a ready MR doesn't flap and notify again
    const url = 'https://gitlab.example.com/g/p/-/merge_requests/114';
    prs.delete(url);
    assert.equal((await glabMr({}, 114)).ready, true);
    prs.get(url).at = 0;
    const checking = await glabMr({ detailed_merge_status: 'checking' }, 114);
    await prs.get(url).pending;
    assert.equal(prs.get(url).value.ready, true, `checking kept ready (first answer ${checking.ready})`);
    console.log('ok gitlab merge statuses');
}

{
    // a merged MR is not asked again every minute
    const url = 'https://gitlab.example.com/g/p/-/merge_requests/121', calls = join(fakeBin, 'calls');
    prs.set(url, { at: 1, value: { state: 'merged' } });
    await withFakeGlab(`echo x >> "${calls}"; exit 1`, () => prState(url));
    assert.equal(statSync(calls, { throwIfNoEntry: false }), undefined);

    // transcripts that aged out of the listing leave the tail and usage caches
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir = join(home, '.claude', 'projects', 'p'), subs = join(dir, 's1', 'subagents');
    mkdirSync(subs, { recursive: true });
    const line = JSON.stringify({ type: 'user', sessionId: 's1', message: { content: 'hi' }, timestamp: new Date().toISOString() }) + '\n';
    writeFileSync(join(dir, 's1.jsonl'), line);
    writeFileSync(join(subs, 'a1.jsonl'), line);
    writeFileSync(join(subs, 'a1.meta.json'), JSON.stringify({ description: 'a', finished: true }));
    const code = `import { sessions } from './server/sessions.mjs'; import { cache, usageCache } from './server/transcripts.mjs';
        await sessions(); const before = [cache.size, usageCache.size];
        const real = Date.now; Date.now = () => real() + 5 * 864e5; // five days later
        await sessions(); console.log(JSON.stringify([before, [cache.size, usageCache.size]]));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out.trim().split('\n').at(-1)), [[2, 1], [0, 0]]);
    rmSync(home, { recursive: true, force: true });
    console.log('ok caches age out');
}

{
    // a failing MR lookup says why on the row instead of "Open the MR to check its state"
    const home = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir = join(home, '.claude', 'projects', 'p');
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString(), url = 'https://gitlab.example.com/g/p/-/merge_requests/9';
    writeFileSync(join(dir, 's1.jsonl'), [{ type: 'user', sessionId: 's1', cwd: join(home, 'p'), message: { content: 'hi' }, timestamp: at }, { type: 'pr-link', prUrl: url, timestamp: at }].map(l => JSON.stringify(l)).join('\n') + '\n');
    // the page gets the failure as a kind and plain words, never the CLI's own text; one MR's 404 is no forge outage, a 401 is
    const code = "import { sessions } from './server/sessions.mjs'; console.log(JSON.stringify((await sessions()).flatMap(s => s.items.map(i => [i.column, i.next, i.forgeError, s.forge?.name, s.forge?.problem]))));";
    const boardWith = stderr => {
        writeFileSync(join(fakeBin, 'glab'), `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`, { mode: 0o755 });
        const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, HOMEBASE_DIR: join(home, 'hb'), PATH: `${fakeBin}:${process.env.PATH}` }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
        return JSON.parse(out.trim().split('\n').at(-1))[0];
    };
    const [col, next, rowError, name, problem] = boardWith('glab: 404 Not Found');
    assert.deepEqual([col, name, problem], ['unknown', 'GitLab', null]);
    assert.doesNotMatch(`${next} ${rowError}`, /404|glab:/);
    assert.ok(rowError);
    const denied = boardWith('glab: 401 Unauthorized. try authenticating with glab auth login');
    assert.deepEqual([denied[0], denied[4]], ['unknown', 'auth']);
    assert.doesNotMatch(`${denied[1]} ${denied[2]}`, /401|Unauthorized/);
    rmSync(home, { recursive: true, force: true });
    console.log('ok forge error shown');

    // a failing comment fetch is flagged too, so a row without its review threads doesn't look clean
    const home2 = mkdtempSync(join(tmpdir(), 'hb-home-'));
    const dir2 = join(home2, '.claude', 'projects', 'p');
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, 's1.jsonl'), [{ type: 'user', sessionId: 's1', cwd: join(home2, 'p'), message: { content: 'hi' }, timestamp: at }, { type: 'pr-link', prUrl: url, timestamp: at }].map(l => JSON.stringify(l)).join('\n') + '\n');
    writeFileSync(join(fakeBin, 'glab'), `#!/bin/sh\ncase "$2" in\n*discussions*) echo "glab: 403 Forbidden" >&2; exit 1;;\n*user) echo '{"username":"me"}';;\n*) echo '${JSON.stringify({ state: 'opened', title: 't', source_branch: 'b', detailed_merge_status: 'not_approved' })}';;\nesac\n`, { mode: 0o755 });
    const code2 = "import { sessions } from './server/sessions.mjs'; await sessions(); await new Promise(r => setTimeout(r, 1500)); console.log(JSON.stringify((await sessions()).flatMap(s => s.items.map(i => i.forgeError))));";
    const out2 = execFileSync(process.execPath, ['--input-type=module', '-e', code2], { env: { ...process.env, HOME: home2, PATH: `${fakeBin}:${process.env.PATH}` }, cwd: join(import.meta.dirname, '../..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out2.trim().split('\n').at(-1)), ['comments: the lookup failed']);
    rmSync(home2, { recursive: true, force: true });
    console.log('ok comment error shown');
}
