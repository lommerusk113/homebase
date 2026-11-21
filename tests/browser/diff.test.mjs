// The Changes view over the fixture's gamma repo, which each test fills with its own commits and files and then puts back as the fixture made it.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ORIGIN = 'git@gitlab.com:acme/gamma.git';
const store = (base, n) => `// Session store\nexport function load(id) {\n    return read(id);\n}\n${Array.from({ length: n }, (_, i) => `export const k${i} = ${base + i};`).join('\n')}\n`;

// main (also origin/main) with one commit; branch 7-session-store with one more; then modified, untracked and binary files.
function fill(repo) {
    const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args]);
    mkdirSync(join(repo, 'src/server'), { recursive: true });
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    writeFileSync(join(repo, 'src/server/store.js'), store(0, 40));
    writeFileSync(join(repo, 'README.md'), '# gamma\n\nA fixture.\n');
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', '7-session-store');
    writeFileSync(join(repo, 'src/server/store.js'), store(0, 40).replace('return read(id);', 'const hit = cache.get(id);\n    return hit ?? read(id);').replace('k20 = 20', 'k20 = 2000'));
    writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    git('commit', '-q', '-am', 'cache the store');
    writeFileSync(join(repo, 'README.md'), `# gamma\n\nA fixture with a session store.\n\n${'A very long line that does not wrap. '.repeat(20)}\n`);
    writeFileSync(join(repo, 'notes <img src=x onerror=window.pwned=1>.md'), '<img src=x onerror=window.pwned=1>\nsecond line\n');
    writeFileSync(join(repo, 'src/server/long.js'), Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    writeFileSync(join(repo, 'shot.bin'), Buffer.from([1, 0, 2, 0]));
}
function reset(repo) {
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', ORIGIN]);
}
async function withRepo(homebase, fn) {
    const repo = join(homebase, '..', 'home', 'repos', 'gamma');
    reset(repo);
    fill(repo);
    try {
        await fn();
    } finally {
        reset(repo);
    }
}
// Two running helpers of the gamma chat, each in its own linked worktree of gamma: agent-dirty's has an edit, agent-clean's has none.
async function withHelpers(homebase, gammaId, fn) {
    const repo = join(homebase, '..', 'home', 'repos', 'gamma'), wts = join(homebase, '..', 'worktrees');
    const sub = join(homebase, '..', 'home', '.claude', 'projects', '-fx-gamma', gammaId, 'subagents');
    mkdirSync(sub, { recursive: true });
    const at = new Date().toISOString();
    for (const name of ['dirty', 'clean']) {
        const wt = join(wts, name);
        execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', `worktree-agent-${name}`, wt, 'main']);
        writeFileSync(join(sub, `agent-${name}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description: `Helper ${name}`, worktreePath: wt, worktreeBranch: `worktree-agent-${name}` }));
        writeFileSync(join(sub, `agent-${name}.jsonl`), [
            { type: 'user', isSidechain: true, sessionId: gammaId, cwd: wt, timestamp: at, message: { role: 'user', content: `Helper ${name}` } },
            { type: 'assistant', isSidechain: true, sessionId: gammaId, cwd: wt, uuid: `h-${name}`, timestamp: at, message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `b-${name}`, name: 'Bash', input: { command: 'npm test' } }] } }
        ].map(e => JSON.stringify(e)).join('\n') + '\n');
    }
    writeFileSync(join(wts, 'dirty', 'README.md'), '# gamma\n\nEdited by the helper.\n');
    try {
        await fn();
    } finally {
        rmSync(sub, { recursive: true, force: true });
        rmSync(wts, { recursive: true, force: true });
    }
}
async function asPhone(page, fn) {
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    try {
        await fn();
    } finally {
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    }
}
// DIFF_SHOTS=<dir> saves diff-<name>-<light|dark>.png there
async function shots(page, name) {
    if (!process.env.DIFF_SHOTS) {
        return;
    }
    for (const scheme of ['light', 'dark']) {
        await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        writeFileSync(join(process.env.DIFF_SHOTS, `diff-${name}-${scheme}.png`), Buffer.from((await page.cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    }
    await page.cmd('Emulation.setEmulatedMedia', { features: [] });
}

const files = `[...document.querySelectorAll('.dv-file')].map(b => [b.dataset.group, b.querySelector('.dv-st').textContent, b.dataset.path, b.querySelector('.dv-counts').textContent])`;
const current = `(document.querySelector('.dv-file[aria-current="true"]')?.dataset.path ?? null)`;
const lines = cls => `[...document.querySelectorAll('.dv-l${cls}')].map(l => l.textContent)`;
const pickFile = async (page, path) => {
    await page.clickOn(`[...document.querySelectorAll('.dv-file')].find(b => b.dataset.path.startsWith(${JSON.stringify(path)}))`, path);
    await page.waitFor(`document.querySelector('.dv-path').textContent.startsWith(${JSON.stringify(path)}) && !document.querySelector('.dv-code').textContent.startsWith('Loading')`, { what: `${path} shown` });
};
const gamma = IDS => ({ project: 'gamma', chat: IDS.gamma });

export default {
    'a chat whose repo has no changes: the Changes button has no count and the panel says so; Esc closes': async ({ page, open, IDS }) => {
        await open(gamma(IDS));
        await page.waitFor(`document.getElementById('c-diff') && !document.getElementById('c-diff').hidden`, { what: 'the Changes button' });
        assert.equal(await page.ev(`document.querySelector('.c-diff-n').hidden`), true, 'no count');
        await page.click('#c-diff');
        await page.waitFor(`document.querySelector('.dv.empty .dv-note')?.textContent.startsWith('No changes')`, { what: 'the empty state' });
        assert.equal(await page.ev(`document.querySelectorAll('.dv-file').length`), 0);
        await page.key('Escape', 'Escape');
        await page.waitFor(`!document.querySelector('.dv')`, { what: 'closed' });
    },

    'Tab stays inside the open Changes panel, and closing gives the page back': async ({ page, open, IDS }) => {
        await open(gamma(IDS));
        await page.waitFor(`document.getElementById('c-diff') && !document.getElementById('c-diff').hidden`, { what: 'the Changes button' });
        await page.click('#c-diff');
        await page.waitFor(`document.querySelector('.dv.empty .dv-note')`, { what: 'the panel' });
        for (let i = 0; i < 8; i++) {
            await page.key('Tab', 'Tab');
            assert.ok(await page.ev(`!!document.activeElement.closest('.dv') || document.activeElement === document.body`), `Tab ${i + 1} left the panel`);
        }
        await page.key('Escape', 'Escape');
        await page.waitFor(`!document.querySelector('.dv')`, { what: 'closed' });
        assert.equal(await page.ev(`document.querySelectorAll('[inert]').length`), 0, 'nothing stays inert');
    },

    'd opens the changes of the chat: grouped files with counts, the first diff, an untracked and a binary file, j/k, Esc': async ({ page, open, IDS, homebase }) => {
        await withRepo(homebase, async () => {
            await open(gamma(IDS));
            await page.waitFor(`document.querySelector('.c-diff-n')?.textContent === '6' && !document.querySelector('.c-diff-n').hidden`, { what: 'six changed files on the button' });
            await shots(page, 'chat-head');
            await page.ev(`document.activeElement?.blur()`);
            await page.key('d');
            await page.waitFor(`document.querySelector('.dv-l.add')`, { what: 'the panel with the first diff' });
            assert.equal(await page.ev(`document.querySelector('.dv-title').textContent`), 'gamma 7-session-store → origin/main');
            assert.equal(await page.ev(`document.querySelector('.dv-totals').textContent`), '6 files +6 −3');
            assert.deepEqual(await page.ev(`[...document.querySelectorAll('.dv-group')].map(h => h.textContent)`), ['Uncommitted · 4', 'Committed on this branch · 2']);
            assert.deepEqual(await page.ev(files), [
                ['uncommitted', 'M', 'README.md', '+3 −1'],
                ['uncommitted', '?', 'notes <img src=x onerror=window.pwned=1>.md', 'new'],
                ['uncommitted', '?', 'shot.bin', 'new'],
                ['uncommitted', '?', 'src/server/long.js', 'new'],
                ['committed', 'M', 'logo.png', 'binary'],
                ['committed', 'M', 'src/server/store.js', '+3 −2']
            ]);
            assert.equal(await page.ev(`document.querySelector('.dv-mr').hidden`), true, 'no MR known for this branch');

            // the first file is picked: its diff with line numbers, a hunk header, and a long line that scrolls sideways
            assert.equal(await page.ev(current), 'README.md');
            assert.deepEqual(await page.ev(lines('.del')), ['3-A fixture.']);
            assert.match((await page.ev(lines('.add')))[0], /^3\+A fixture with a session store\.$/);
            assert.match((await page.ev(lines('.hunk')))[0], /^@@ -1,3 \+1,5 @@/);
            assert.equal(await page.ev(`(() => { const c = document.querySelector('.dv-code'); return c.scrollWidth > c.clientWidth && document.documentElement.scrollWidth <= innerWidth; })()`), true, 'the diff scrolls, the page does not');
            const tint = await page.ev(`[getComputedStyle(document.querySelector('.dv-l.add')).backgroundColor, getComputedStyle(document.querySelector('.dv-l.del')).backgroundColor, getComputedStyle(document.querySelector('.dv-l:not(.add):not(.del):not(.hunk)')).backgroundColor]`);
            assert.equal(new Set(tint).size, 3, `added, removed and context lines differ: ${tint}`);

            // the committed diff is against the base
            await pickFile(page, 'src/server/store.js');
            assert.deepEqual(await page.ev(lines('.del')), ['3-    return read(id);', '25-export const k20 = 20;']);
            assert.deepEqual(await page.ev(lines('.add')), ['3+    const hit = cache.get(id);', '4+    return hit ?? read(id);', '26+export const k20 = 2000;']);
            assert.equal(await page.ev(`document.querySelectorAll('.dv-l.hunk').length`), 2);
            await shots(page, '1440');

            // an untracked file: its content as added lines, as text; nothing in it or in its name becomes markup
            await pickFile(page, 'notes ');
            assert.deepEqual(await page.ev(lines('')), ['1+<img src=x onerror=window.pwned=1>', '2+second line']);
            assert.equal(await page.ev(`document.querySelectorAll('.dv img').length + (window.pwned ?? 0)`), 0);
            // a long one is drawn in parts
            await pickFile(page, 'src/server/long.js');
            assert.equal(await page.ev(`document.querySelectorAll('.dv-l').length`), 500);
            assert.equal(await page.ev(`document.querySelector('.dv-more').textContent`), 'Show more (700 lines left)');
            await page.click('.dv-more');
            await page.waitFor(`document.querySelectorAll('.dv-l').length === 1000`, { what: 'the next 500 lines' });
            // binary files, tracked and untracked
            await pickFile(page, 'logo.png');
            assert.equal(await page.ev(`document.querySelector('.dv-code').textContent`), 'Binary file: no text diff.');
            await pickFile(page, 'shot.bin');
            assert.equal(await page.ev(`document.querySelector('.dv-code').textContent`), 'Binary file: no text diff.');

            // j/k and the arrows move between files, clamped; the board behind does not react
            await page.key('k');
            await page.waitFor(`${current}?.startsWith('notes ')`, { what: 'k: the file above' });
            await page.key('ArrowUp', 'ArrowUp');
            await page.key('ArrowUp', 'ArrowUp');
            await page.waitFor(`${current} === 'README.md'`, { what: 'the first file, clamped' });
            await page.key('j');
            await page.key('ArrowDown', 'ArrowDown');
            await page.waitFor(`${current} === 'shot.bin'`, { what: 'two down' });
            await page.key('?', 'Slash');
            assert.equal(await page.ev(`!!document.querySelector('wa-dialog[label="Keyboard shortcuts"]')`), false, 'the shortcuts overlay stays shut under the panel');

            // copy path, then a refresh keeps the picked file
            await page.ev(`navigator.clipboard.writeText = t => { window.copied = t; return Promise.resolve(); }`);
            await page.click('.dv-copy');
            await page.waitFor(`window.copied === 'shot.bin' && document.querySelector('.dv-copy').textContent === 'Copied'`, { what: 'the path copied' });
            await page.key('r');
            await page.waitFor(`!document.querySelector('.dv.loading') && ${current} === 'shot.bin'`, { what: 'refreshed, same file' });

            await page.key('Escape', 'Escape');
            await page.waitFor(`!document.querySelector('.dv')`, { what: 'closed' });
            assert.deepEqual(page.posts, [], 'read-only: nothing was posted');
        });
    },

    'on a phone the file list comes first; a tap shows the diff with a back button, and every target is 44px': async ({ page, open, IDS, homebase }) => {
        await withRepo(homebase, async () => {
            await asPhone(page, async () => {
                await open(gamma(IDS));
                await page.waitFor(`document.querySelector('.c-diff-n')?.textContent === '6'`, { what: 'the count' });
                const head = await page.ev(`(() => { const b = document.getElementById('c-diff').getBoundingClientRect(), m = document.querySelector('#chat .c-head').getBoundingClientRect(); return { h: b.height, right: Math.round(m.right), w: innerWidth }; })()`);
                assert.ok(head.h >= 40 && head.right <= head.w, `the button fits the chat header: ${JSON.stringify(head)}`);
                await page.click('#c-diff');
                await page.waitFor(`document.querySelectorAll('.dv-file').length === 6`, { what: 'the file list' });
                const shown = cls => `(document.querySelector('.${cls}').offsetParent !== null)`;
                assert.equal(await page.ev(`${shown('dv-files')} && !${shown('dv-pane')} && !${shown('dv-back')} && ${current} === null`), true, 'the list only, nothing picked');
                assert.equal(await page.ev(`[...document.querySelectorAll('.dv-file, .dv-head .dv-btn')].filter(b => b.offsetParent && (b.getBoundingClientRect().height < 44 || b.getBoundingClientRect().right > innerWidth)).length`), 0, '44px targets, inside the screen');
                await shots(page, '390-list');
                await pickFile(page, 'src/server/store.js');
                assert.equal(await page.ev(`${shown('dv-pane')} && !${shown('dv-files')} && ${shown('dv-back')}`), true, 'the diff, with a back button');
                assert.equal(await page.ev(`document.querySelectorAll('.dv-l.add').length`), 3);
                assert.equal(await page.ev(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.dv-head .dv-btn, .dv-copy')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 44).length === 0`), true);
                await shots(page, '390');
                await page.click('.dv-back');
                await page.waitFor(`${shown('dv-files')} && !${shown('dv-pane')}`, { what: 'the list again' });
                await page.click('.dv-close');
                await page.waitFor(`!document.querySelector('.dv')`, { what: 'closed' });
            });
        });
    },

    'a helper row whose worktree has changes gets a Changes icon that opens that worktree; a clean one and MR rows get none': async ({ page, open, IDS, homebase }) => {
        await withRepo(homebase, async () => {
            await withHelpers(homebase, IDS.gamma, async () => {
                await open(gamma(IDS));
                const icon = key => `document.querySelector('#masters tr[data-key="${key}"] .act .dv-row')`;
                await page.waitFor(`document.querySelector('#masters tr[data-key="agent-clean"]') && ${icon('agent-dirty')}`, { what: 'both helper rows, the icon on the dirty one' });
                assert.equal(await page.ev(`!!${icon('agent-clean')}`), false, 'no icon without changes');
                assert.deepEqual(await page.ev(`[${icon('agent-dirty')}.getAttribute('aria-label'), ${icon('agent-dirty')}.getAttribute('title'), ${icon('agent-dirty')}.getAttribute('appearance')]`), ['Changes', 'Changes', 'plain']);
                await shots(page, 'row');
                await page.clickOn(icon('agent-dirty'), 'the icon');
                await page.waitFor(`document.querySelector('.dv-l.add')`, { what: "the worktree's diff" });
                assert.equal(await page.ev(`document.querySelector('.dv-title').textContent`), 'dirty worktree-agent-dirty → origin/main');
                assert.deepEqual(await page.ev(files), [['uncommitted', 'M', 'README.md', '+1 −1']]);
                assert.equal(await page.ev(`document.querySelector('#masters tr[data-key="agent-dirty"] + tr.detail')`), null, 'the click opened the panel, not the row');
                await page.key('Escape', 'Escape');
                await page.waitFor(`!document.querySelector('.dv')`, { what: 'closed' });
                // MR rows (no worktree) never get one
                await open({ project: 'alpha' });
                await page.waitFor(`document.querySelectorAll('#masters tr[data-key^="https://"]').length >= 3`, { what: 'MR rows' });
                assert.equal(await page.ev(`document.querySelectorAll('#masters tr[data-key^="https://"] .dv-row').length`), 0);
                assert.deepEqual(page.posts, [], 'read-only: nothing was posted');
            });
        });
    }
};
