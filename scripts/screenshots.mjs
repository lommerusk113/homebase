// Takes the README screenshots: `node scripts/screenshots.mjs [outDir]` (default docs/img). Same isolated setup as
// tests/browser/run.mjs: fixture HOME with invented transcripts, stub glab/gh, a tmux socket that never exists, headless
// Chrome that may only reach localhost. It never sees your sessions or the real server.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connect, sleep } from '../tests/browser/cdp.mjs';
import { buildFixture, IDS } from '../tests/browser/fixture.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = process.argv[2] ?? join(REPO, 'docs', 'img');
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const freePort = () => new Promise((ok, fail) => { const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); }); });

const tmp = mkdtempSync(join(tmpdir(), 'homebase-shots-'));
const procs = [];
process.on('exit', () => { procs.forEach(p => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }); rmSync(tmp, { recursive: true, force: true }); });

const { home, bin } = buildFixture(tmp);
// the stub's test-flavoured titles become shop-like ones (the stub is copied; the tests' own file is untouched)
const TITLES = { 'Stored-only: scrolled out of every tail': 'Add order history page', 'Forge-only: never in a transcript': 'Update shipping rates', 'Credit note is not a payment': 'Fix refund rounding' };
const fixtureDir = fileURLToPath(new URL('../tests/browser/', import.meta.url));
let stub = readFileSync(join(fixtureDir, 'forge-stub.mjs'), 'utf8').replace("'./fixture.mjs'", JSON.stringify(join(fixtureDir, 'fixture.mjs')));
for (const [from, to] of Object.entries(TITLES)) {
    stub = stub.replaceAll(from, to);
}
writeFileSync(join(tmp, 'forge-stub.mjs'), stub);
for (const cli of ['glab', 'gh']) {
    writeFileSync(join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${join(tmp, 'forge-stub.mjs')}" ${cli} "$@"\n`, { mode: 0o755 });
}
const itemsFile = join(tmp, 'homebase', 'items.json');
writeFileSync(itemsFile, readFileSync(itemsFile, 'utf8').replaceAll('Stored-only: scrolled out of every tail', TITLES['Stored-only: scrolled out of every tail']));
// the diff shown on the work page: a branch with a commit and an uncommitted edit in one fixture repo
const repo = join(home, 'repos', 'gamma');
const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a]);
git('symbolic-ref', 'HEAD', 'refs/heads/main');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src/cart.js'), 'export function total(items) {\n    let sum = 0;\n    for (const i of items) {\n        sum += i.price;\n    }\n    return sum;\n}\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('checkout', '-q', '-b', '7-cart-discount');
writeFileSync(join(repo, 'src/cart.js'), 'export function total(items, discount = 0) {\n    let sum = 0;\n    for (const i of items) {\n        sum += i.price * i.qty;\n    }\n    return sum * (1 - discount);\n}\n');
git('commit', '-q', '-am', 'Apply a discount to the cart total');
writeFileSync(join(repo, 'README.md'), '# Cart\n\nTotals are computed in src/cart.js.\n');

const port = await freePort(), base = `http://localhost:${port}/`;
const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOMEBASE_DIR: join(tmp, 'homebase'), HOMEBASE_STATUSLINE_DIR: join(tmp, 'statusline'),
    HOMEBASE_TMUX_SOCKET: `homebase-shots-${process.pid}`, HOMEBASE_STUB_LOG: join(tmp, 'forge.log'), HOMEBASE_CODE_DIR: join(tmp, 'code') };
delete env.HOMEBASE_LAN;
for (const f of ['server.mjs', 'server/rules.mjs', 'public/styles.css']) {
    mkdirSync(join(env.HOMEBASE_CODE_DIR, f, '..'), { recursive: true });
    writeFileSync(join(env.HOMEBASE_CODE_DIR, f), '');
}
const server = spawn(process.execPath, ['server.mjs'], { cwd: REPO, env, stdio: 'ignore', detached: true });
procs.push(server);
for (let i = 0; i < 100 && !(await fetch(base).then(r => r.ok, () => false)); i++) {
    await sleep(100);
}

const debugPort = await freePort();
procs.push(launchChrome(CHROME, debugPort, join(tmp, 'profile')));
const page = await connect(debugPort);
page.route = q => (q.method === 'POST' ? { body: 'ok' } : null); // nothing is ever sent anywhere

const size = (width, height, mobile = false) => page.cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const open = async (storage = {}) => {
    await page.goto(base);
    const s = { tracked: '["alpha","beta","gamma"]', project: 'alpha', tab: 'work', chat: IDS.master, 'auto-compact': '0', ...storage };
    await page.ev(`localStorage.clear(); ${Object.entries(s).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join(' ')}`);
    writeFileSync(join(env.HOMEBASE_DIR, 'tracked.json'), s.tracked);
    await page.goto(base);
    await page.waitFor(`document.querySelector('#masters tr[data-key], #masters .welcome') && document.getElementById('status-text').textContent !== 'Connecting…'`);
    await sleep(1500);
};
const shot = async name => {
    await page.ev(`document.getElementById('format-warn').style.display = 'none'`); // the fixture's Claude Code version is invented
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(300);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
};
mkdirSync(OUT, { recursive: true });
await size(1400, 850);

await open();
await shot('board');

await page.ev(`document.querySelector('#feed button.show')?.click()`); // open a collapsed reply
await sleep(300);
await shot('chat');

await open({ project: 'beta', chat: IDS.asker });
await shot('question');

await open({ project: 'gamma', chat: IDS.gamma });
await page.waitFor(`document.getElementById('c-diff') && !document.getElementById('c-diff').hidden`);
await page.click('#c-diff');
await page.waitFor(`document.querySelector('.dv-l.add')`);
await page.clickOn(`[...document.querySelectorAll('.dv-file')].find(b => b.dataset.path === 'src/cart.js')`);
await page.waitFor(`document.querySelector('.dv-path').textContent.startsWith('src/cart.js') && document.querySelector('.dv-l.del')`);
await sleep(400);
await shot('diff');

await open();
await page.click('#attach-btn');
await sleep(600);
await shot('composer');

await size(390, 844, true);
await open();
await shot('phone');
console.log('saved to', OUT);
process.exit(0);
