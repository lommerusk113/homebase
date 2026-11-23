import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseNumstat, parseNameStatus, parseStatus, changes, fileBody, diffFolder, diff, MAX_DIFF_BYTES } from '../../server.mjs';
import { parseDiff, addedRows, diffTotals } from '../../web/src/lib/diff.ts';

{
    // git's -z output: paths are raw, whatever they contain
    const odd = 'we ird "q\'\n$(x)\t.txt';
    assert.deepEqual([...parseNumstat(`3\t1\tsrc/a.js\0-\t-\timg.png\x000\t0\t${odd}\0`)],
        [['src/a.js', { add: 3, del: 1, binary: false }], ['img.png', { add: null, del: null, binary: true }], [odd, { add: 0, del: 0, binary: false }]]);
    assert.deepEqual(parseNameStatus(`M\0src/a.js\0A\0${odd}\0D\0gone.txt\0`), [{ status: 'M', path: 'src/a.js' }, { status: 'A', path: odd }, { status: 'D', path: 'gone.txt' }]);
    assert.deepEqual(parseStatus(` M src/a.js\0A  staged.txt\0MM both.txt\0?? ${odd}\0 D gone.txt\0`),
        [{ status: 'M', path: 'src/a.js' }, { status: 'A', path: 'staged.txt' }, { status: 'M', path: 'both.txt' }, { status: '?', path: odd }, { status: 'D', path: 'gone.txt' }]);
    assert.deepEqual(parseStatus(''), []);

    // a throwaway repo: one commit on main (also origin/main), a branch with a commit, then uncommitted and untracked files
    const root = mkdtempSync(join(tmpdir(), 'homebase-diff-')), repo = join(root, 'repo');
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args]);
    try {
        mkdirSync(join(repo, 'src'), { recursive: true });
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        const top = String(git('rev-parse', '--show-toplevel')).trim(); // the temp dir's real path
        assert.deepEqual((await changes(repo)).view, { repo: 'repo', branch: 'main', base: null, uncommitted: [], committed: [], truncated: false }, 'no commits yet');
        writeFileSync(join(repo, 'src/a.js'), 'one\ntwo\nthree\n');
        writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
        writeFileSync(join(repo, 'big.txt'), 'x\n');
        git('add', '-A');
        assert.deepEqual((await changes(repo)).view.uncommitted.map(f => [f.status, f.path, f.add]), [['A', 'big.txt', 1], ['A', 'logo.bin', null], ['A', 'src/a.js', 3]], 'staged in a repo without commits');
        assert.match((await fileBody(await changes(repo), 'uncommitted', 'src/a.js')).diff, /^\+three$/m);
        git('commit', '-q', '-m', 'base');
        git('update-ref', 'refs/remotes/origin/main', 'HEAD');
        git('checkout', '-q', '-b', 'feature');
        writeFileSync(join(repo, 'src/a.js'), 'one\n2\nthree\n');
        writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 9, 9, 9]));
        git('commit', '-q', '-am', 'change');
        writeFileSync(join(repo, 'src/a.js'), 'one\n2\nthree\nfour\n');
        writeFileSync(join(repo, 'big.txt'), 'y'.repeat(MAX_DIFF_BYTES + 10));
        writeFileSync(join(repo, odd), 'hello\nworld\n');
        writeFileSync(join(repo, 'new.bin'), Buffer.from([1, 0, 1]));
        writeFileSync(join(root, 'secret.txt'), 'outside the repo');
        symlinkSync(join(root, 'secret.txt'), join(repo, 'link.txt'));

        const found = await changes(join(repo, 'src')); // a subfolder shows its whole repo
        const { view } = found, sha = String(git('rev-parse', 'main')).trim();
        assert.equal(found.top, top);
        assert.deepEqual([view.repo, view.branch, view.base, view.truncated], ['repo', 'feature', { ref: 'origin/main', sha }, false]);
        assert.deepEqual(view.committed, [{ status: 'M', path: 'logo.bin', add: null, del: null, binary: true }, { status: 'M', path: 'src/a.js', add: 1, del: 1, binary: false }]);
        const byPath = (a, b) => (a[1] < b[1] ? -1 : 1);
        assert.deepEqual(view.uncommitted.map(f => [f.status, f.path, f.add, f.del]).sort(byPath),
            [['M', 'big.txt', 1, 1], ['M', 'src/a.js', 1, 0], ['?', 'link.txt', null, null], ['?', 'new.bin', null, null], ['?', odd, null, null]].sort(byPath));

        assert.match((await fileBody(found, 'committed', 'src/a.js')).diff, /^-two\n\+2$/m);
        const un = (await fileBody(found, 'uncommitted', 'src/a.js')).diff;
        assert.ok(/^\+four$/m.test(un) && !/^-two$/m.test(un), 'uncommitted is against HEAD, not the base');
        assert.deepEqual(await fileBody(found, 'committed', 'logo.bin'), { binary: true });
        assert.deepEqual(await fileBody(found, 'uncommitted', 'new.bin'), { binary: true }, 'an untracked binary file');
        assert.deepEqual(await fileBody(found, 'uncommitted', odd), { text: 'hello\nworld\n' }, 'a name with spaces, quotes, a newline and $()');
        assert.deepEqual(await fileBody(found, 'uncommitted', 'big.txt'), { tooLarge: true });
        assert.deepEqual(await fileBody(found, 'uncommitted', 'link.txt'), { text: '' }, 'an untracked symlink is never followed');
        // only a path git listed, in the group it was listed in
        for (const [group, path] of [['uncommitted', '../secret.txt'], ['uncommitted', join(root, 'secret.txt')], ['uncommitted', '/etc/passwd'], ['uncommitted', 'src/../src/a.js'], ['uncommitted', './src/a.js'],
            ['uncommitted', 'logo.bin'], ['committed', odd], ['uncommitted', '.git/config'], ['uncommitted', ''], ['uncommitted', '--output=/tmp/x'], ['nope', 'src/a.js'], ['__proto__', 'src/a.js'], ['repo', 'src/a.js']]) {
            await assert.rejects(fileBody(found, group, path), { status: 404, message: 'unknown file' }, `${group} ${path}`);
        }

        assert.deepEqual((await changes(root)).view, { repo: null }, 'not a git repository');
        assert.deepEqual((await changes(null)).view, { repo: null }, 'the folder is gone');

        // a folder laid out like a git dir, planted inside the repo with its own config: its filter command must never run
        const evil = join(repo, 'vendor', 'evil'), wt = join(evil, 'wt'), marker = join(root, 'marker');
        const inEvil = (...args) => execFileSync('git', ['-c', 'safe.bareRepository=all', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', `--git-dir=${evil}`, `--work-tree=${wt}`, ...args], { stdio: 'pipe' });
        execFileSync('git', ['init', '-q', '--bare', evil]);
        mkdirSync(wt);
        writeFileSync(join(wt, 'f.txt'), 'one\n');
        inEvil('add', '-A');
        inEvil('commit', '-q', '-m', 'planted');
        inEvil('config', 'core.bare', 'false');
        inEvil('config', 'core.worktree', wt);
        inEvil('config', 'filter.x.clean', `touch '${marker}'; cat`);
        writeFileSync(join(wt, '.gitattributes'), '* filter=x\n');
        writeFileSync(join(wt, 'f.txt'), 'one\ntwo\n');
        execFileSync('git', ['-C', evil, '-c', 'safe.bareRepository=all', 'diff', 'HEAD'], { stdio: 'pipe' });
        assert.ok(readdirSync(root).includes('marker'), 'the fixture works: plain git runs the planted filter');
        rmSync(marker);
        for (const dir of [evil, wt, join(evil, 'objects')]) {
            const v = (await changes(dir)).view;
            assert.ok(v.repo === null || v.repo === 'repo', `never the planted repo: ${JSON.stringify(v)}`);
        }
        assert.deepEqual((await changes(evil)).view, { repo: null });
        assert.equal(readdirSync(root).includes('marker'), false, 'the planted filter did not run');
        rmSync(evil, { recursive: true });
        // a linked worktree (a helper's folder) still works
        git('worktree', 'add', '-q', '-b', 'helper', join(root, 'wt'), 'main');
        assert.deepEqual([(await changes(join(root, 'wt'))).view.repo, (await changes(join(root, 'wt'))).view.branch], ['wt', 'helper']);
        // an item without its own worktree uses the one that has its branch checked out
        const byBranch = async () => [{ id: 's1', cwd: repo, items: [{ key: 'mr', worktreePath: null, branch: 'helper' }, { key: 'gone', worktreePath: null, branch: 'nope' }] }];
        assert.equal(realpathSync(await diffFolder('s1', 'mr', byBranch)), realpathSync(join(root, 'wt')));
        assert.equal(await diffFolder('s1', 'gone', byBranch), null, 'no worktree has that branch');
        git('worktree', 'remove', '--force', join(root, 'wt'));

        // the folder comes from the session list only
        const list = async () => [{ id: 's1', cwd: repo, items: [{ key: 'agent-1', worktreePath: join(repo, 'src') }, { key: 'mr', worktreePath: null }, { key: 'rel', worktreePath: '../x' }] }, { id: 's2', cwd: 'relative/path', items: [{ key: 'other', worktreePath: root }] }];
        assert.equal(await diffFolder('s1', null, list), repo);
        assert.equal(await diffFolder('s1', 'agent-1', list), join(repo, 'src'));
        assert.equal(await diffFolder('s1', 'mr', list), null, 'an item without a worktree never falls back to another folder');
        assert.equal(await diffFolder('s1', 'rel', list), null);
        assert.equal(await diffFolder('s2', null, list), null, 'a relative cwd is not used');
        assert.equal(await diffFolder('s1', 'agent-1', list, () => false), null, 'the worktree was removed');
        for (const [sid, item, message] of [['nope', null, 'unknown session'], [null, null, 'unknown session'], [repo, null, 'unknown session'], ['s1', 'other', 'unknown item'], ['s1', '', 'unknown item'], ['s1', repo, 'unknown item']]) {
            await assert.rejects(diffFolder(sid, item, list), { status: 404, message }, `${sid} ${item}`);
        }
        assert.equal((await diff('s1', null, null, null, list)).branch, 'feature');
        assert.deepEqual(await diff('s1', null, 'uncommitted', odd, list), { text: 'hello\nworld\n' });
        await assert.rejects(diff('s1', null, 'uncommitted', '../secret.txt', list), { status: 404 });
        await assert.rejects(diff('s2', null, 'uncommitted', 'src/a.js', list), { status: 404 }, 'no repo, no files');
        await assert.rejects(diff('nope', null, null, null, list), { status: 404 });
    } finally {
        rmSync(root, { recursive: true });
    }

    // the page's side: a unified diff as numbered rows
    const rows = parseDiff('diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,3 +1,4 @@ function x() {\n one\n-two\n+2\n+<b>2b</b>\n three\n\\ No newline at end of file\n@@ -10 +11,0 @@\n-ten\n');
    assert.deepEqual(rows, [
        { t: 'h', text: '@@ -1,3 +1,4 @@ function x() {' }, { t: ' ', o: 1, n: 1, text: 'one' }, { t: '-', o: 2, text: 'two' }, { t: '+', n: 2, text: '2' }, { t: '+', n: 3, text: '<b>2b</b>' },
        { t: ' ', o: 3, n: 4, text: 'three' }, { t: 'm', text: 'No newline at end of file' }, { t: 'h', text: '@@ -10 +11,0 @@' }, { t: '-', o: 10, text: 'ten' }
    ]);
    assert.deepEqual(parseDiff(''), []);
    assert.deepEqual(parseDiff('diff --git a/x b/x\nold mode 100644\nnew mode 100755\n'), [], 'a mode change has no hunks');
    assert.deepEqual(addedRows('a\n\nb\n'), [{ t: '+', n: 1, text: 'a' }, { t: '+', n: 2, text: '' }, { t: '+', n: 3, text: 'b' }]);
    assert.deepEqual(addedRows(''), []);
    assert.deepEqual(diffTotals({ repo: 'r', uncommitted: [{ path: 'a', status: 'M', add: 2, del: 1, binary: false }, { path: 'n', status: '?', add: null, del: null, binary: false }], committed: [{ path: 'a', status: 'M', add: 5, del: 0, binary: false }] }),
        { files: 2, add: 7, del: 1 });
    console.log('ok diff');
}
