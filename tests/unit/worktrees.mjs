// Issue worktree cleanup (server/worktrees.mjs) with a fake git: only a clean, unused worktree of a merged or closed MR goes, by `git worktree remove`.
import assert from 'node:assert/strict';
import { cleanupWorktrees, blocker, CHECK_MS } from '../../server/worktrees.mjs';

const REPO = '/r/proj', WT = `${REPO}/.claude/worktrees/12-fix-it`;
const mr = n => `https://gitlab.com/g/proj/-/merge_requests/${n}`;
const item = (extra = {}, ps = {}) => ({ key: mr(5), pr: mr(5), project: 'proj', branch: '12-fix-it', prState: { state: 'merged', sha: 'abc' }, ...extra, ...(Object.keys(ps).length && { prState: { state: 'merged', sha: 'abc', ...ps } }) });
const chat = (extra = {}) => ({ id: 's1', project: 'proj', cwd: REPO, status: 'idle', tmux: 'cc-s1', items: [item()], ...extra });

// a fake git: answers by the command; `state` says what the worktree is like
const fake = (state = {}) => {
    const calls = [];
    const git = async args => {
        calls.push(args.join(' '));
        const cmd = args.slice(2).join(' ');
        const fail = (code = 1) => Promise.reject(Object.assign(new Error('fail'), { code, stderr: 'fatal: nope' }));
        if (cmd.startsWith('rev-parse')) {
            return { stdout: `${REPO}/.git\n` };
        }
        if (cmd === 'worktree list --porcelain') {
            return { stdout: `worktree ${REPO}\nbranch refs/heads/main\n\nworktree ${WT}\nHEAD abc\nbranch refs/heads/12-fix-it\n\nworktree ${REPO}/.claude/worktrees/helper-x\nbranch refs/heads/helper/x\n` };
        }
        if (cmd.startsWith('status')) {
            return { stdout: state.dirty ?? '' };
        }
        if (cmd.startsWith('merge-base')) {
            return state.inMr === false ? fail() : { stdout: '' };
        }
        if (cmd.startsWith('rev-list')) {
            return { stdout: `${state.unpushed ?? 0}\n` };
        }
        if (cmd.startsWith('worktree remove')) {
            return state.removeFails ? fail() : { stdout: '' };
        }
        if (cmd.startsWith('branch -d')) {
            return state.branchFails ? fail() : { stdout: '' };
        }
        return { stdout: '' };
    };
    return { git, calls };
};
let clock = 1_000_000; // each run is a later pass: the module remembers when it last looked at a kept worktree
const run = async (list, tmuxList, state, now = (clock += 2 * CHECK_MS)) => {
    const f = fake(state), logs = [];
    const done = await cleanupWorktrees(list, tmuxList, { git: f.git, now, log: m => logs.push(m) });
    return { ...f, logs, done };
};
const removed = r => r.calls.filter(c => c.includes('worktree remove') || c.includes('branch -d'));

// clean and unused: removed with `git worktree remove` (no force), then the branch with -d
{
    const r = await run([chat()], [], {});
    assert.deepEqual(removed(r), [`-C ${REPO} worktree remove ${WT}`, `-C ${REPO} branch -d 12-fix-it`]);
    assert.equal(r.done.length, 1);
    assert.match(r.logs[0], /removed .* branch 12-fix-it deleted/);
    assert.ok(!r.calls.some(c => /--force| -f|rm /.test(c)));
}
// a closed MR too; a squash-merged branch that git calls unmerged stays and says so
{
    const r = await run([chat({ items: [item({}, { state: 'closed' })] })], [], { branchFails: true });
    assert.equal(removed(r).length, 2);
    assert.match(r.logs[0], /kept: not fully merged/);
}
// kept, with the reason logged once: open MR, not an issue branch, GitHub, changes, unpushed commits, a chat or tmux in it
const keeps = [
    ['an open MR', chat({ items: [item({}, { state: 'open' })] }), [], {}, null],
    ['a helper branch', chat({ items: [item({ branch: 'helper/x' })] }), [], {}, null],
    ['a GitHub PR', chat({ items: [item({ pr: 'https://github.com/o/r/pull/5', key: 'g' })] }), [], {}, null],
    ['changes', chat(), [], { dirty: '?? notes.txt' }, 'uncommitted or untracked'],
    ['unpushed', chat(), [], { inMr: false, unpushed: 2 }, '2 commits not pushed'],
    ['a chat working in it', chat({ items: [item()] }) && [chat(), { id: 's2', project: 'proj', cwd: WT, status: 'working', items: [] }], [], {}, 'in use'],
    ['an idle chat with a live tmux', [chat(), { id: 's2', project: 'proj', cwd: `${WT}/sub`, status: 'idle', tmux: 'cc-s2', items: [] }], [{ name: 'cc-s2', path: '/elsewhere' }], {}, null], // (the same reason is logged once)
    ['a tmux started in it', chat(), [{ name: 'cc-x', path: WT }], {}, null]
];
for (const [name, list, tmuxList, state, why] of keeps) {
    const r = await run(Array.isArray(list) ? list : [list], tmuxList, state);
    assert.equal(removed(r).length, 0, name);
    if (why) {
        assert.match(r.logs.join('\n'), why === 'in use' ? /a chat or tmux session is using it/ : new RegExp(why), name);
    }
}
// unpushed commits that the MR's own head holds (a pushed branch) are fine; a failed remove is logged and nothing else happens
assert.equal(removed(await run([chat()], [], { inMr: true, unpushed: 5 })).length, 2);
{
    const r = await run([chat()], [], { removeFails: true });
    assert.equal(removed(r).length, 1);
    assert.match(r.logs[0], /kept: fatal: nope/);
}
// the reason is logged once, and a kept worktree is looked at again after CHECK_MS
{
    const f = fake({ dirty: 'M a.js' }), logs = [], opts = now => ({ git: f.git, now, log: m => logs.push(m) });
    await cleanupWorktrees([chat()], [], opts(5_000_000));
    await cleanupWorktrees([chat()], [], opts(5_000_000 + CHECK_MS - 1));
    assert.equal(logs.length, 1);
    await cleanupWorktrees([chat()], [], opts(5_000_000 + CHECK_MS));
    assert.equal(logs.length, 1, 'same reason: not logged again');
}
assert.equal(await blocker(WT, 'abc', [], [], fake().git), null);
console.log('ok worktree cleanup');
