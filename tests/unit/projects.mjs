import assert from 'node:assert/strict';
import { claudeLine } from '../../server/tmux.mjs';

{
    const { validName, mergeConfig, createProject, cloneProject, githubProjects, NEW_PROJECT_DEFAULTS } = await import('../../server.mjs');
    const { homedir } = await import('node:os');

    // name validation
    for (const n of ['a', 'my-repo', 'a.b_c-1', 'x'.repeat(100)]) {
        assert.equal(validName(n), true, n);
    }
    for (const n of ['', '.hidden', '..', 'a b', 'a/b', '../x', 'x'.repeat(101), 'é', 'a;rm', undefined, 42]) {
        assert.equal(validName(n), false, String(n));
    }

    // config merging
    assert.deepEqual(mergeConfig(undefined), { ...NEW_PROJECT_DEFAULTS, baseDir: `${homedir()}/Projects` });
    assert.deepEqual([NEW_PROJECT_DEFAULTS.owner, NEW_PROJECT_DEFAULTS.keychainService, NEW_PROJECT_DEFAULTS.sshHost], ['', '', 'github.com']);
    const merged = mergeConfig({ newProject: { owner: 'someone', private: false, baseDir: '/tmp/x' } });
    assert.deepEqual([merged.owner, merged.private, merged.baseDir, merged.sshHost], ['someone', false, '/tmp/x', 'github.com']);
    assert.throws(() => mergeConfig({ newProject: { owner: '-oProxyCommand=x' } }), /newProject.owner/);
    assert.throws(() => mergeConfig({ newProject: { private: 'yes' } }), /newProject.private/);

    // defaults: no keychain, owner detected from gh, nobody is "personal"
    {
        const { resolveOwner, tokenFor, accountOf } = await import('../../server/account.mjs');
        const d = mergeConfig(undefined), seen = [];
        assert.equal(await tokenFor(d), null);
        assert.equal(await resolveOwner(d, async (f, args) => (seen.push([f, ...args]), { stdout: 'octo\n' })), 'octo');
        assert.deepEqual(seen, [['gh', 'api', 'user', '--jq', '.login']]);
        assert.equal(await resolveOwner({ owner: 'me' }, async () => assert.fail('configured owner needs no gh')), 'me');
        assert.equal(accountOf({ host: 'github.com', path: 'octo/x' }, d), 'work');
    }

    // the step runner, with every command stubbed: no keychain, gh, git or tmux is ever touched
    const TOKEN = 'ghp_SECRET_TOKEN_123';
    const PERSONAL = { owner: 'lommerusk113', keychainService: 'gh-personal', sshHost: 'github-personal' };
    const config = mergeConfig({ newProject: { ...PERSONAL, baseDir: '/base' } });
    const fake = ({ pane = '', failOn, leak } = {}) => {
        const calls = [];
        const exec = async (file, args, opts = {}) => {
            calls.push({ file, args, env: opts.env, timeout: opts.timeout });
            if (file === 'security') {
                return { stdout: `${TOKEN}\n` };
            }
            if (file === failOn) {
                throw Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}`), { stderr: leak ? `HTTP 403 for token ${TOKEN}\n` : 'HTTP 403: Resource not accessible\n' });
            }
            return { stdout: '' };
        };
        const tm = async args => {
            if (args[0] === 'capture-pane') {
                return { stdout: pane };
            }
            calls.push({ file: 'tmux', args });
            if (failOn === 'tmux') {
                throw new Error('no server');
            }
        };
        return { calls, deps: { config, exec, tmux: tm, exists: () => false, transcripts: async () => ['11111111-2222-3333-4444-555555555555.jsonl'], nap: async () => {}, waitMs: 1000 } };
    };
    const noToken = v => assert.ok(!JSON.stringify(v).includes(TOKEN), 'token must not appear');

    {
        const { calls, deps } = fake();
        const r = await createProject({ name: 'my-repo', description: 'A thing', private: true }, deps);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'git', 'tmux']);
        assert.deepEqual(calls[0].args, ['find-generic-password', '-s', 'gh-personal', '-w']);
        assert.deepEqual(calls[1].args, ['repo', 'create', 'lommerusk113/my-repo', '--private', '--description', 'A thing', '--add-readme']);
        assert.equal(calls[1].env.GH_TOKEN, TOKEN);
        assert.equal('GITHUB_TOKEN' in calls[1].env, false, 'work token is removed');
        assert.deepEqual(calls[2].args, ['clone', 'git@github-personal:lommerusk113/my-repo.git', '/base/my-repo']);
        assert.ok(!JSON.stringify(calls[2]).includes(TOKEN) && !JSON.stringify(calls[3]).includes(TOKEN), 'only gh gets the token');
        assert.ok(calls.every(c => c.file === 'tmux' || c.timeout > 0), 'every step has a timeout');
        assert.deepEqual(calls[3].args, ['new-session', '-d', '-s', 'cc-new-my-repo', '-x', '200', '-y', '50', '-c', '/base/my-repo', 'zsh', '-lic', claudeLine()]);
        assert.deepEqual([r.ok, r.sessionId, r.dir, r.steps.map(s => s.state)], [true, '11111111-2222-3333-4444-555555555555', '/base/my-repo', ['done', 'done', 'done']]);
        noToken(r);
    }
    {
        const { calls, deps } = fake();
        const r = await createProject({ name: 'pub', private: false }, { ...deps, transcripts: async () => [] });
        assert.ok(calls[1].args.includes('--public') && !calls[1].args.includes('--description'));
        assert.equal(r.sessionId, null, 'no transcript in time: the chat is still starting');
    }
    {
        const { calls, deps } = fake({ failOn: 'gh', leak: true });
        const e = await createProject({ name: 'x' }, deps).catch(e => e);
        assert.deepEqual([e.status, e.body.steps.map(s => s.state)], [502, ['failed', 'pending', 'pending']]);
        assert.match(e.message, /HTTP 403 for token \[token\]/);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh'], 'nothing further after gh fails');
        assert.ok(!e.message.includes(TOKEN) && !JSON.stringify(e.body).includes(TOKEN));
    }
    {
        const e = await createProject({ name: 'x' }, fake({ failOn: 'git' }).deps).catch(e => e);
        assert.match(e.message, /github\.com\/lommerusk113\/x was created, but cloning to \/base\/x failed, so nothing is cloned/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['done', 'failed', 'pending']);
        noToken(e.body);
    }
    {
        const e = await createProject({ name: 'x' }, fake({ failOn: 'tmux' }).deps).catch(e => e);
        assert.match(e.message, /was created and cloned to \/base\/x, but starting Claude failed/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['done', 'done', 'failed']);
    }
    {
        const { deps } = fake();
        const keychain = await createProject({ name: 'x' }, { ...deps, exec: async () => { throw new Error('item not found'); } }).catch(e => e);
        assert.match(keychain.message, /could not read keychain item "gh-personal"/);
        for (const [body, d, re] of [[{ name: '../x' }, deps, /Invalid name/], [{ name: 'x', description: 'd'.repeat(351) }, deps, /Description/], [{ name: 'x' }, { ...deps, exists: () => true }, /already exists/]]) {
            const e = await createProject(body, d).catch(e => e);
            assert.deepEqual([e.status, re.test(e.message)], [400, true], e.message);
        }
        const both = fake();
        const [a, b] = await Promise.allSettled([createProject({ name: 'dup' }, both.deps), createProject({ name: 'dup' }, both.deps)]);
        assert.deepEqual([a.status, b.reason?.status], ['fulfilled', 409], 'the same name twice at once');
    }

    // cloning one of the owner's repos: gh lists, the name must be in the list, then the shared clone + chat steps
    const LIST = [
        { name: 'old', description: null, isPrivate: false, updatedAt: '2026-01-01T00:00:00Z', isArchived: false },
        { name: 'dead', description: 'x', isPrivate: true, updatedAt: '2026-12-01T00:00:00Z', isArchived: true },
        { name: 'new', description: 'Fresh', isPrivate: true, updatedAt: '2026-11-01T00:00:00Z', isArchived: false }
    ];
    const withList = (o = {}) => {
        const f = fake(o);
        const exec = f.deps.exec;
        f.deps.exec = async (file, args, opts) => file === 'gh' ? (f.calls.push({ file, args, env: opts.env }), { stdout: JSON.stringify(LIST) }) : exec(file, args, opts);
        f.deps.ttl = 0;
        return f;
    };
    {
        const { calls, deps } = withList();
        const l = await githubProjects({ ...deps, exists: p => p === '/base/old' });
        assert.deepEqual(l.map(r => [r.name, r.local]), [['new', false], ['old', true]], 'newest first, archived out, local marked');
        assert.deepEqual(calls[1].args, ['repo', 'list', 'lommerusk113', '--limit', '200', '--json', 'name,description,isPrivate,updatedAt,isArchived']);
        assert.equal(calls[1].env.GH_TOKEN, TOKEN);
        assert.equal('GITHUB_TOKEN' in calls[1].env, false);
        const e = await githubProjects({ ...fake({ failOn: 'gh', leak: true }).deps, ttl: 0 }).catch(e => e);
        assert.deepEqual([e.status, e.message], [502, 'Could not list repos: HTTP 403 for token [token]']);
    }
    {
        const { calls, deps } = withList();
        const r = await cloneProject({ name: 'new' }, deps);
        assert.deepEqual(calls.map(c => c.file), ['security', 'gh', 'git', 'tmux']);
        assert.deepEqual(calls[2].args, ['clone', 'git@github-personal:lommerusk113/new.git', '/base/new']);
        assert.deepEqual(calls[3].args.slice(0, 4), ['new-session', '-d', '-s', 'cc-new-new']);
        assert.deepEqual([r.ok, r.repo, r.dir, r.sessionId, r.steps.map(s => [s.id, s.state])], [true, 'lommerusk113/new', '/base/new', '11111111-2222-3333-4444-555555555555', [['clone', 'done'], ['chat', 'done']]]);
        noToken(r);
    }
    {
        const { calls, deps } = withList();
        for (const [name, d, status, re] of [['nope', deps, 404, /no repo named nope/], ['dead', deps, 404, /no repo named dead/], ['../x', deps, 400, /Invalid name/], ['new', { ...deps, exists: () => true }, 400, /already exists/]]) {
            const e = await cloneProject({ name }, d).catch(e => e);
            assert.deepEqual([e.status, re.test(e.message)], [status, true], name);
        }
        assert.ok(!calls.some(c => c.file === 'git' || c.file === 'tmux'), 'nothing cloned or started');
        const e = await cloneProject({ name: 'new' }, withList({ failOn: 'git' }).deps).catch(e => e);
        assert.match(e.message, /^Cloning to \/base\/new failed, so nothing is cloned:/);
        assert.deepEqual(e.body.steps.map(s => s.state), ['failed', 'pending']);
        const t = await cloneProject({ name: 'new' }, withList({ failOn: 'tmux' }).deps).catch(e => e);
        assert.match(t.message, /^Cloned to \/base\/new, but starting Claude failed/);
        assert.deepEqual(t.body.steps.map(s => s.state), ['done', 'failed']);
    }
    console.log('ok new project');
}

{
    // Open: the folder check, then only the start-chat step; real folders in a temp dir, tmux and transcripts stubbed
    const { allowedDir, openProject, localProjects, githubProjects, mergeConfig } = await import('../../server.mjs');
    const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, utimesSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'hb-open-')));
    const base = join(root, 'base'), outside = join(root, 'outside'), cwd = join(root, 'elsewhere', 'proj');
    for (const d of [join(base, 'app', '.git'), join(base, 'old', '.git'), join(base, 'busy', '.git'), join(base, 'plain'), outside, cwd]) {
        mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(base, 'file.txt'), '');
    symlinkSync(outside, join(base, 'escape'));
    symlinkSync(join(base, 'app'), join(root, 'link-in'));
    const ok = { baseDir: base, cwds: [cwd] };
    const refused = async (dir, status, re, o = ok) => {
        const e = await allowedDir(dir, o).then(() => null, e => e);
        assert.ok(e, `${dir} must be refused`);
        assert.deepEqual([e.status, re.test(e.message)], [status, true], `${dir}: ${e.message}`);
    };
    assert.equal(await allowedDir(join(base, 'app'), ok), join(base, 'app'));
    assert.equal(await allowedDir(join(base, 'plain'), ok), join(base, 'plain'), 'a plain folder is enough');
    assert.equal(await allowedDir(join(base, 'app', '..', 'old'), ok), join(base, 'old'), '".." that stays inside');
    assert.equal(await allowedDir(join(root, 'link-in'), ok), join(base, 'app'), 'a symlink into baseDir is its target');
    assert.equal(await allowedDir(cwd, ok), cwd, 'a known session cwd outside baseDir');
    await refused(join(base, '..', 'outside'), 403, /is not in/);
    await refused(join(base, 'app', '..', '..', 'outside'), 403, /is not in/);
    await refused(join(base, 'escape'), 403, /is not in/, ok); // a symlink in baseDir that points out
    await refused(outside, 403, /is not in/);
    await refused(base, 403, /is not in/, ok); // baseDir itself
    await refused(`${base}-evil`, 400, /is not a folder/);
    mkdirSync(`${base}x`);
    await refused(`${base}x`, 403, /is not in/); // a sibling sharing baseDir's prefix
    await refused(join(cwd, '..'), 403, /is not in/, ok); // a known cwd's parent
    await refused(join(base, 'nope'), 400, /is not a folder/);
    await refused(join(base, 'file.txt'), 400, /is not a folder/);
    for (const d of ['app', '../base/app', '', undefined, 42, `${base}/app\n`]) {
        await refused(d, 400, /absolute folder path|is not a folder/);
    }

    const config = mergeConfig({ newProject: { baseDir: base } });
    const calls = [];
    const deps = {
        config, cwds: async () => [cwd], project: async d => (d.endsWith('proj') ? 'my repo' : 'app'),
        tmux: async args => { calls.push(args); if (args[0] === 'capture-pane') { return { stdout: '' }; } },
        transcripts: (() => { let n = 0; return async () => (n++ ? ['old.jsonl', 'new.jsonl'] : ['old.jsonl']); })(),
        nap: async () => {}, waitMs: 1000, trustMs: 0
    };
    const r = await openProject({ dir: join(base, 'app') }, deps);
    assert.deepEqual(calls[0], ['new-session', '-d', '-s', 'cc-new-app', '-x', '200', '-y', '50', '-c', join(base, 'app'), 'zsh', '-lic', claudeLine()]);
    assert.deepEqual([r.ok, r.name, r.dir, r.tmux, r.sessionId, r.steps.map(s => [s.id, s.state])], [true, 'app', join(base, 'app'), 'cc-new-app', 'new', [['chat', 'done']]], 'an older transcript is not this chat');
    assert.equal((await openProject({ dir: cwd }, { ...deps, transcripts: async () => [] })).tmux, 'cc-new-my-repo', 'the tmux name is made safe');
    calls.length = 0;
    const e = await openProject({ dir: outside }, deps).catch(e => e);
    assert.deepEqual([e.status, calls], [403, []], 'nothing started outside');
    const t = await openProject({ dir: join(base, 'app') }, { ...deps, tmux: async () => { throw new Error('duplicate session: cc-new-app'); } }).catch(e => e);
    assert.deepEqual([t.status, t.message, t.body.steps.map(s => s.state)], [502, `Starting Claude in ${join(base, 'app')} failed: duplicate session: cc-new-app`, ['failed']]);

    // the list: git repos under baseDir, newest .git first, busy ones out
    const at = s => new Date(Date.now() - s * 1000);
    utimesSync(join(base, 'app', '.git'), at(10), at(10));
    utimesSync(join(base, 'old', '.git'), at(5000), at(5000));
    const l = await localProjects({ config, busy: async () => [join(base, 'busy', '.claude', 'worktrees', 'x')] });
    assert.deepEqual(l.map(p => [p.name, p.dir]), [['app', join(base, 'app')], ['old', join(base, 'old')]]);

    // From my GitHub tells the page each repo's folder, so a cloned one can be opened
    const gh = await githubProjects({ config, ttl: 0, exists: d => d === join(base, 'app'), exec: async (f) => ({ stdout: f === 'gh' ? JSON.stringify([{ name: 'app', description: '', isPrivate: true, updatedAt: '2026-01-01T00:00:00Z', isArchived: false }]) : 'me\n' }) });
    assert.deepEqual(gh.map(r => [r.name, r.local, r.dir]), [['app', true, join(base, 'app')]]);
    rmSync(root, { recursive: true, force: true });
    console.log('ok open project');
}
