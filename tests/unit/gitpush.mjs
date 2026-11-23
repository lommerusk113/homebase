import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pushRefusal, pushSession, pushBlocked, WORK_REFUSAL } from '../../server/gitpush.mjs';

// decision: hobby pushes any branch; work repos never the default branch, main or master
assert.equal(pushRefusal({ hobby: true, branch: 'main', defaultBranch: 'main' }), null);
assert.equal(pushRefusal({ hobby: false, branch: '12-fix', defaultBranch: 'main' }), null);
assert.equal(pushRefusal({ hobby: false, branch: 'main', defaultBranch: 'main' }), WORK_REFUSAL);
assert.equal(pushRefusal({ hobby: false, branch: 'master', defaultBranch: null }), WORK_REFUSAL);
assert.equal(pushRefusal({ hobby: false, branch: 'develop', defaultBranch: 'develop' }), WORK_REFUSAL);
assert.match(pushRefusal({ hobby: true, branch: '-f', defaultBranch: null }), /No branch/);
assert.match(pushRefusal({ hobby: true, branch: null, defaultBranch: null }), /No branch/);
console.log('ok push decision');

// real pushes into a temp bare remote
const tmp = mkdtempSync(join(tmpdir(), 'hb-gitpush-'));
const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
const remote = join(tmp, 'remote.git'), repo = join(tmp, 'repo');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
g(repo, 'remote', 'add', 'origin', remote);
g(repo, 'commit', '-q', '--allow-empty', '-m', 'one');
g(repo, 'push', '-q', '-u', 'origin', 'main');
g(repo, 'checkout', '-q', '-b', 'feature');
g(repo, 'commit', '-q', '--allow-empty', '-m', 'two');
const list = hobby => async () => [{ id: 's1', cwd: repo, hobby }];

await assert.rejects(pushSession('nope', list(true)), { status: 404 });
await assert.rejects(pushSession('s1', async () => [{ id: 's1', cwd: join(tmp, 'missing'), hobby: true }]), { status: 400 });

// work repo, feature branch: pushed, upstream set with -u
assert.deepEqual(await pushSession('s1', list(false)), { branch: 'feature', unpushed: 0 });
assert.match(g(remote, 'branch', '--list', 'feature'), /feature/);
assert.equal(await pushBlocked({ cwd: repo, branch: 'feature', hobby: false }), false);

// work repo on main: refused, nothing pushed; the button hides
g(repo, 'checkout', '-q', 'main');
g(repo, 'commit', '-q', '--allow-empty', '-m', 'three');
await assert.rejects(pushSession('s1', list(false)), { status: 400, message: WORK_REFUSAL });
assert.equal(await pushBlocked({ cwd: repo, branch: 'main', hobby: false }), true);
assert.equal(await pushBlocked({ cwd: repo, branch: 'main', hobby: true }), false);

// hobby repo on main: pushed
assert.equal((await pushSession('s1', list(true))).branch, 'main');
assert.equal(g(remote, 'rev-parse', 'main').trim(), g(repo, 'rev-parse', 'main').trim());

// never forced: a diverged branch is rejected with git's last error line, the remote keeps its commit
const other = join(tmp, 'other');
execFileSync('git', ['clone', '-q', remote, other]);
g(other, 'commit', '-q', '--allow-empty', '-m', 'theirs');
g(other, 'push', '-q', 'origin', 'main');
const theirs = g(remote, 'rev-parse', 'main').trim();
g(repo, 'commit', '-q', '--allow-empty', '-m', 'mine');
await assert.rejects(pushSession('s1', list(true)), e => e.status === 409 && e.message.length > 0 && !e.message.includes('\n'));
assert.equal(g(remote, 'rev-parse', 'main').trim(), theirs);
console.log('ok git push');
