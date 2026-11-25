import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// start from issue: slug, assignee guard, request validation, worktree reuse (in a temp repo, never a real one)
{
    const { branchSlug, takenBy, startPrompt, validateStart, prepareWorktree, startIssue } = await import('../../server.mjs');

    assert.equal(branchSlug('Sprint 12: Fix login redirect!'), 'sprint-12-fix-login-redirect');
    assert.equal(branchSlug('../../etc/passwd; rm -rf ~'), 'etc-passwd-rm-rf');
    assert.equal(branchSlug('é'), 'issue');
    const long = branchSlug('word '.repeat(30));
    assert.ok(long.length <= 40 && /^[a-z0-9-]+$/.test(long) && !long.endsWith('-'), long);

    const me = { username: 'tester' }, ann = { username: 'ann', name: 'Ann' };
    assert.equal(takenBy([], me), null, 'unassigned: anybody');
    assert.equal(takenBy([me, ann], me), null, 'me among the assignees');
    assert.equal(takenBy([ann], me), 'Ann');
    assert.equal(takenBy([ann], null), 'Ann', 'unknown me never takes it');
    assert.equal(startPrompt(7, []), 'Assign #7 to me first (it is unassigned), then implement it.');
    assert.equal(startPrompt(7, [ann]), 'Implement #7');

    const repos = new Map([['alpha', { host: 'gitlab.com', path: 'acme/alpha' }], ['beta', { host: 'github.com', path: 'acme/beta' }]]);
    assert.deepEqual(validateStart({ project: 'alpha', iid: 12 }, repos), { project: 'alpha', iid: '12', repo: repos.get('alpha') });
    const statusOf = body => { try { validateStart(body, repos); } catch (e) { return e.status; } };
    for (const [body, status] of [[{ project: 'alpha', iid: '1; rm' }, 400], [{ project: 'alpha', iid: '-1' }, 400], [{ project: 'alpha' }, 400], [null, 400],
        [{ project: 'nope', iid: 1 }, 404], [{ project: '__proto__', iid: 1 }, 404], [{ project: 'beta', iid: 1 }, 400]]) {
        assert.equal(statusOf(body), status, JSON.stringify(body));
    }

    // a temp repo with an origin: the issue branch is made from origin/main without a push, then reused
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hb-start-')));
    const origin = join(root, 'origin.git'), repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, repo], { stdio: 'ignore' });
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
    g('commit', '-q', '--allow-empty', '-m', 'init');
    g('push', '-q', 'origin', 'HEAD:main');
    g('fetch', '-q', 'origin');

    const first = await prepareWorktree(repo, '12', 'Fix: login', 'origin/main');
    assert.deepEqual([first.dir, first.reused, existsSync(first.dir)], [join(repo, '.claude', 'worktrees', '12-fix-login'), false, true]);
    assert.equal(g('rev-parse', '12-fix-login').trim(), g('rev-parse', 'origin/main').trim());
    assert.equal(g('ls-remote', '--heads', 'origin').includes('12-fix-login'), false, 'nothing pushed');
    assert.deepEqual(await prepareWorktree(repo, '12', 'Another title', 'origin/main'), { dir: first.dir, reused: true });
    g('worktree', 'remove', first.dir);
    const again = await prepareWorktree(repo, '12', 'Another title', 'origin/main');
    assert.deepEqual([again.dir, again.reused], [first.dir, false], 'an existing branch without a worktree gets one under its own name');

    // the endpoint: someone else's issue stops before anything is touched; mine reuses the worktree's chat
    const issue = assignees => async () => ({ title: 'Fix: login', assignees });
    const base = { repos, meOf: async () => me, dirOf: async () => repo, tmux: async () => { throw new Error('no tmux'); } };
    const e = await startIssue({ project: 'alpha', iid: 12 }, { ...base, issueOf: issue([ann]) }).catch(x => x);
    assert.deepEqual([e.status, e.message], [403, 'Assigned to Ann, only they can start it']);
    const r = await startIssue({ project: 'alpha', iid: 12 }, { ...base, issueOf: issue([me]), known: async () => [{ id: 'sess1', cwd: first.dir }] }).catch(x => x);
    assert.deepEqual([r.sessionId, r.reused], ['sess1', true]);
}

// manual mode: claudeLine adds the rule only for manual chats, and a marked chat keeps it on resume
{
    const { claudeLine } = await import('../../server/tmux.mjs');
    const { MANUAL_RULE, markManual, isManual } = await import('../../server/manual.mjs');
    const { mkdtempSync } = await import('node:fs');
    assert.ok(!claudeLine('', '/none', { saver: false, checks: '' }).includes('Manual mode'));
    assert.ok(!claudeLine('', '/none', { saver: false, manual: false, checks: '' }).includes('Manual mode'));
    assert.match(claudeLine(' --resume x', '/none', { saver: false, manual: true, checks: '' }), /^PATH='.*\/bin':\$PATH claude --append-system-prompt 'Manual mode: .*' --resume x$/);
    assert.ok(claudeLine('', '/none', { saver: false, manual: true, checks: '' }).includes(MANUAL_RULE));

    process.env.HOMEBASE_DIR = mkdtempSync(join(tmpdir(), 'hb-manual-'));
    markManual('aaaaaaaa-1111');
    markManual('bad id; rm');
    assert.deepEqual([isManual('aaaaaaaa-1111'), isManual('bbbbbbbb-2222'), isManual('bad id; rm')], [true, false, false]);
    delete process.env.HOMEBASE_DIR;
}

// manual mode talks first: its prompt is read-only discussion, and the board's Plan it is a canned button
{
    const { startPrompt } = await import('../../server.mjs');
    const { canned, cannedLabel } = await import('../../web/src/lib/canned.ts');
    assert.match(startPrompt(9, [], true), /^Read issue #9 with `glab issue view 9 --comments` .* Don't change code or start helpers until I say so\.$/);
    assert.equal(cannedLabel(startPrompt(9, [], true)), 'Start #9');
    assert.deepEqual(canned('plan'), { label: 'Plan it', message: "/grill-me Let's make the plan for this issue together." });
    assert.equal(cannedLabel(canned('plan').message), 'Plan it');

    // review button: only an MR on the review list starts, in the project's checkout
    const { startReview, reviewPrompt } = await import('../../server.mjs');
    const rr = { url: 'https://gitlab.com/acme/alpha/-/merge_requests/9', iid: 9, project: 'acme/alpha' };
    const rbase = { requests: () => [rr], repos: new Map([['alpha', {}]]), dirOf: async () => '/tmp', tmux: async () => { throw new Error('no tmux'); } };
    const none = await startReview({ url: 'https://evil.example/x' }, rbase).catch(x => x);
    assert.equal(none.status, 404);
    const noTmux = await startReview({ url: rr.url }, rbase).catch(x => x);
    assert.match(noTmux.message, /Starting Claude/, 'a listed MR gets as far as starting the chat');
    assert.match(reviewPrompt(rr), /!9 of acme\/alpha .*do not push, comment/);
}
