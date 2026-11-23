import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, saveChecks, readChecks, checksStatus, settingsFlag } from '../../server/checks.mjs';

// The Stop hook's decision: real git repo and sh commands in temp dirs
{
    const d = mkdtempSync(join(tmpdir(), 'hb-'));
    const repo = join(mkdtempSync(join(tmpdir(), 'hb-')), 'proj');
    execFileSync('sh', ['-c', `mkdir ${repo} && cd ${repo} && git init -q && git -c user.email=a@b -c user.name=n commit -q --allow-empty -m x`]);
    const h = { session_id: '11111111-2222-3333-4444-555555555555', cwd: repo };
    const set = (...commands) => saveChecks('proj', JSON.stringify({ commands }), d);
    let runs = 0;
    const counting = (cmd, cwd) => { runs++; assert.equal(cwd, repo); return { ok: cmd !== 'false', out: `out of ${cmd}` }; };

    assert.equal(decide(h, { d }), null, 'no commands configured: the hook does nothing');
    assert.equal(checksStatus(h.session_id, d), null);
    assert.throws(() => saveChecks('../x', '{"commands":[]}', d), { status: 400 });

    set('true');
    assert.equal(decide(h, { d, run: counting }), null);
    assert.equal(checksStatus(h.session_id, d).state, 'pass');
    assert.equal(runs, 1);
    decide(h, { d, run: counting });
    assert.equal(runs, 1, 'unchanged files after a pass: not run again');
    writeFileSync(join(repo, 'a.txt'), 'changed');
    decide(h, { d, run: counting });
    assert.equal(runs, 2, 'changed files: run again');

    // real commands: false blocks with the command and its output
    set('echo boom; false');
    writeFileSync(join(repo, 'a.txt'), 'changed again');
    const out = decide(h, { d });
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /echo boom; false\nboom/);
    assert.equal(checksStatus(h.session_id, d).state, 'fail');

    // 3 blocked stops in a row with the same failure, then the stop is allowed and recorded as failing
    assert.equal(decide(h, { d }).decision, 'block');
    assert.equal(decide(h, { d }).decision, 'block');
    assert.equal(decide(h, { d }), null, 'fourth identical failure: allowed');
    assert.equal(checksStatus(h.session_id, d).state, 'fail');
    assert.equal(JSON.parse(readFileSync(join(d, 'checks', `${h.session_id}.json`))).gaveUp, true);

    // a different failure restarts the count; a pass stores the hash
    set('false');
    assert.equal(decide(h, { d, run: counting }).decision, 'block');
    set('true');
    assert.equal(decide(h, { d }), null);
    assert.equal(checksStatus(h.session_id, d).state, 'pass');

    // only the first failing command runs and is named; output is cut to the last 30 lines
    set('seq 1 100; false', 'echo never');
    writeFileSync(join(repo, 'a.txt'), 'x');
    const long = decide(h, { d }).reason;
    assert.ok(long.includes('\n100') && !long.includes('\n70\n') && long.includes('\n71\n'));

    // the commands come from the config only, and the settings file is Homebase's own
    assert.deepEqual(readChecks('proj', d), ['seq 1 100; false', 'echo never']);
    assert.match(settingsFlag(d, '/a b'), / --settings '.*checks-settings\.json'$/);
    assert.match(readFileSync(join(d, 'checks-settings.json'), 'utf8'), /"Stop".*node '\/a b\/hooks\/checks\.mjs'/);
    assert.equal(checksStatus(h.session_id, d, Date.now() + 3_600_000).state, 'fail');
    rmSync(d, { recursive: true });
    console.log('ok checks');
}
