// Headless browser tests: `node tests/browser/run.mjs [-v] [name-filter...]`. No dependencies, only Node and a local Chrome
// (CHROME=/path/to/chrome to override). Starts its own server on a free port over a fixture HOME with stub glab/gh, so
// it never sees real sessions, tmux, GitLab or the :4321 server. Exits non-zero when a test fails.
// Prints only failures and the summary (full log in last-run.log; -v prints it all). One run at a time per machine: a lock file waits out parallel runs.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, connect, sleep } from './cdp.mjs';
import { buildFixture, touchSession, IDS } from './fixture.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..');
const CHROME = process.env.CHROME ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
const TEST_TIMEOUT_MS = 45_000;

// The Vue islands are part of the page: build web/ first, so the suite always tests the current source.
// ponytail: a full build each run (~1s); skip with HOMEBASE_SKIP_WEB_BUILD=1 when iterating on old-page code only
if (!process.env.HOMEBASE_SKIP_WEB_BUILD) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('npm', ['run', '--silent', 'build'], { cwd: join(REPO, 'web'), stdio: ['ignore', 'ignore', 'inherit'] });
}

const freePort = () => new Promise((ok, fail) => {
    const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => ok(port));
    });
});

const verbose = process.argv.includes('-v');
const LOG = join(HERE, 'last-run.log');
const logLines = [];
// Everything goes to the log; only failures (quiet = false) and -v reach the terminal.
const out = (text, show = verbose) => {
    logLines.push(text);
    if (show) {
        console.log(text);
    }
};

// ponytail: lock = file with the holder's pid, created exclusively; stale when that pid is gone. No fairness, polling every 1s.
const LOCK = join(tmpdir(), 'homebase-browser-suite.lock');
const alive = pid => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
};
let locked = false;
for (let warned = false; !locked;) {
    try {
        closeSync(openSync(LOCK, 'wx'));
        writeFileSync(LOCK, String(process.pid));
        locked = true;
    } catch (e) {
        if (e.code !== 'EEXIST') {
            throw e;
        }
        const pid = Number(readFileSync(LOCK, 'utf8'));
        if (pid && !alive(pid)) { // stale; an empty file is a holder between create and write, so wait for it
            rmSync(LOCK, { force: true });
            continue;
        }
        if (!warned) {
            console.log(`waiting for another suite run (pid ${pid || '?'})…`);
            warned = true;
        }
        await sleep(1000);
    }
}

const tmp = mkdtempSync(join(tmpdir(), 'homebase-browser-'));
const procs = new Set(); // our own children only; each runs in its own process group
const kill = p => {
    try {
        process.kill(-p.pid, 'SIGKILL');
    } catch {}
};
let cleaned = false;
function cleanup() {
    if (cleaned) {
        return;
    }
    cleaned = true;
    procs.forEach(kill);
    rmSync(tmp, { recursive: true, force: true });
    if (locked) {
        rmSync(LOCK, { force: true });
    }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { cleanup(); process.exit(130); });
}

const { home, bin } = buildFixture(tmp);
const appPort = await freePort();
const base = `http://localhost:${appPort}/`;
const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    PORT: String(appPort),
    HOMEBASE_DIR: join(tmp, 'homebase'),
    HOMEBASE_STATUSLINE_DIR: join(tmp, 'statusline'),
    HOMEBASE_TMUX_SOCKET: `homebase-browser-test-${process.pid}`, // a tmux server that never exists
    HOMEBASE_CLAUDE_BIN: join(import.meta.dirname, '../fixtures/fake-claude.sh'), // a started chat or helper runs this, never the real claude
    HOMEBASE_STUB_LOG: join(tmp, 'forge.log'),
    HOMEBASE_CODE_DIR: join(tmp, 'code') // the restart test touches these stand-ins, never the real files other runs share
};
for (const f of ['server.mjs', 'server/rules.mjs', 'public/styles.css']) {
    mkdirSync(join(env.HOMEBASE_CODE_DIR, f, '..'), { recursive: true });
    writeFileSync(join(env.HOMEBASE_CODE_DIR, f), '');
}
delete env.HOMEBASE_LAN;
// The remote (tailscale serve) port, reached in the tests as http://localhost:<port> instead of the tailnet name.
const remotePort = await freePort();
const remoteBase = `http://localhost:${remotePort}/`;
const configFile = join(env.HOMEBASE_DIR, 'config.json'); // the fixture wrote newProject; add remote
writeFileSync(configFile, JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), remote: { host: `localhost:${remotePort}`, port: remotePort } }));

let server, serverLog = '';
async function startServer() {

    server = spawn(process.execPath, ['server.mjs'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    procs.add(server);
    const exited = new Promise(r => server.once('exit', r));
    server.exited = exited;
    server.stdout.on('data', d => { serverLog += d; });
    server.stderr.on('data', d => { serverLog += d; });
    for (let i = 0; i < 100; i++) {
        if (await fetch(base).then(r => r.ok, () => false)) {
            return;
        }
        await sleep(100);
    }
    throw new Error(`server did not start:\n${serverLog}`);
}
async function stopServer() {
    kill(server);
    await server.exited;
    procs.delete(server);
}

await startServer();
const debugPort = await freePort();
if (!CHROME) {
    throw new Error('no Chrome found; set CHROME=/path/to/chrome');
}
const chrome = launchChrome(CHROME, debugPort, join(tmp, 'profile'));
procs.add(chrome);
const page = await connect(debugPort);

// POSTs never reach the server: nothing is ever typed into a session, and refresh answers at once.
const answerPosts = q => {
    if (q.method !== 'POST') {
        return null;
    }
    if (q.url.includes('/api/refresh')) {
        return { body: JSON.stringify({ refreshing: false, lastRefreshedAt: Date.now() }), headers: { 'content-type': 'application/json' } };
    }
    return { body: 'ok' };
};

const DEFAULTS = { tracked: '["alpha","beta","gamma"]', project: 'alpha', tab: 'work', chat: IDS.master, 'auto-compact': '0' }; // auto-compact is on by default; a test that wants it says so (null = unset)
const ctx = {
    page, base, remoteBase, IDS, answerPosts, homebase: env.HOMEBASE_DIR, code: env.HOMEBASE_CODE_DIR,
    // Fresh page: storage reset to DEFAULTS plus overrides (null removes a key), then loaded and the board drawn.
    async open(storage = {}) {
        page.route = answerPosts;
        if (!(await page.ev('location.href').catch(() => '')).startsWith(base)) {
            await page.goto(base);
        }
        const sets = Object.entries({ ...DEFAULTS, ...storage })
            .filter(([, v]) => v != null)
            .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
        await page.ev(`localStorage.clear(); sessionStorage.clear(); ${sets.join(' ')}`);
        // the server's board list (tracked.json) matches, so the page neither replaces its list nor posts one
        const tracked = { ...DEFAULTS, ...storage }.tracked, trackedFile = join(env.HOMEBASE_DIR, 'tracked.json');
        if (tracked == null) {
            rmSync(trackedFile, { force: true });
        } else {
            writeFileSync(trackedFile, tracked);
        }
        await page.goto(base);
        await page.waitFor(`document.querySelector('#masters tr[data-key], #masters .welcome') && document.getElementById('status-text').textContent !== 'Connecting…'`, { what: 'the board and the chat status' });
    },
    restartServer: async () => { await stopServer(); await startServer(); },
    touchSession: (project, id, text) => touchSession(home, project, id, text)
};

const filters = process.argv.slice(2).filter(a => a !== '-v');
const files = readdirSync(HERE).filter(f => f.endsWith('.test.mjs')).sort();
const results = [];
const started = Date.now();
try {
    for (const file of files) {
        const tests = (await import(join(HERE, file))).default;
        for (const [name, fn] of Object.entries(tests)) {
            const full = `${file.replace('.test.mjs', '')}: ${name}`;
            if (filters.length && !filters.some(f => full.includes(f))) {
                continue;
            }
            page.errors.length = 0;
            page.posts.length = 0;
            const t0 = Date.now();
            let error = null;
            try {
                await Promise.race([fn(ctx), sleep(TEST_TIMEOUT_MS).then(() => { throw new Error(`timed out after ${TEST_TIMEOUT_MS / 1000}s`); })]);
            } catch (e) {
                error = e;
            }
            const ms = Date.now() - t0;
            results.push({ full, error, ms });
            out(`${error ? 'FAIL' : 'ok  '} ${full} (${(ms / 1000).toFixed(1)}s)`, !!error || verbose);
            if (error) {
                out(`     ${String(error.stack ?? error).split('\n').slice(0, 6).join('\n     ')}`, true);
                if (page.errors.length) {
                    out(`     page errors: ${JSON.stringify(page.errors.slice(-5))}`, true);
                }
            }
        }
    }
} catch (e) {
    results.push({ full: 'runner', error: e, ms: 0 });
    out(`FAIL runner: ${e.stack ?? e}`, true);
} finally {
    page.close();
    const failed = results.filter(r => r.error);
    // gamma's forge calls fail on purpose (see fixture.mjs); any other FAIL is a missing fixture
    const unknown = existsSync(env.HOMEBASE_STUB_LOG) ? readFileSync(env.HOMEBASE_STUB_LOG, 'utf8').split('\n').filter(l => l.startsWith('FAIL') && !l.includes('gamma')) : [];
    if (unknown.length) {
        out(`\nforge calls without a fixture (add them to forge-stub.mjs):\n  ${[...new Set(unknown)].join('\n  ')}`, true);
    }
    if (failed.length && serverLog.trim()) {
        out(`\nserver output:\n${serverLog.trim().split('\n').slice(-20).join('\n')}`, true);
    }
    out(`\n${results.length - failed.length} passed, ${failed.length} failed in ${((Date.now() - started) / 1000).toFixed(1)}s`, true);
    writeFileSync(LOG, logLines.join('\n') + '\n');
    console.log(`full log: ${LOG}`);
    cleanup();
    process.exit(failed.length || !results.length ? 1 : 0);
}
