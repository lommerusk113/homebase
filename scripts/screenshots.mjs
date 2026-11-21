// Takes the README screenshots: `node scripts/screenshots.mjs [outDir]` (default docs/img). The demo's setup (demo.mjs):
// fixture HOME with invented transcripts, stub glab/gh, a tmux socket that never exists, plus headless Chrome that may
// only reach localhost. It never sees your sessions or the real server.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connect, sleep } from '../tests/browser/cdp.mjs';
import { buildDemo, freePort, IDS } from './demo.mjs';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = process.argv[2] ?? join(REPO, 'docs', 'img');
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);

const tmp = mkdtempSync(join(tmpdir(), 'homebase-shots-'));
const procs = [];
process.on('exit', () => { procs.forEach(p => { try { process.kill(-p.pid, 'SIGKILL'); } catch {} }); rmSync(tmp, { recursive: true, force: true }); });

const port = await freePort(), base = `http://localhost:${port}/`;
const env = buildDemo(tmp).env(port);
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
    await page.cmd('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(300);
    writeFileSync(join(OUT, `${name}.png`), Buffer.from((await page.cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
};
mkdirSync(OUT, { recursive: true });
await size(1400, 850);

await open();
await shot('board');

await page.ev(`document.querySelector('#feed button.show')?.click()`); // open a collapsed reply
await sleep(300);
await page.ev(`document.getElementById('feed').scrollTop = 1e9`); // the opened reply pushed the question's last option out of view
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
