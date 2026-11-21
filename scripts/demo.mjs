// Homebase on invented data, for `node server.mjs --demo` and scripts/screenshots.mjs: the browser tests' fixture (a
// throwaway HOME with made-up transcripts, stub glab/gh) with friendlier content on top, served by a second server
// process on a free port with a tmux socket that never exists. Nothing is read from ~/.claude or typed anywhere.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOMEBASE_FIXTURE_OWNER ??= 'mira-dev'; // read by fixture.mjs as it loads, and by the forge stub the server runs
const { buildFixture, IDS } = await import('../tests/browser/fixture.mjs');
export { IDS };

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURES = join(REPO, 'tests', 'browser');
// the stub's test-flavoured titles become shop-like ones (the stub is copied; the tests' own file is untouched)
const TITLES = { 'Stored-only: scrolled out of every tail': 'Add order history page', 'Forge-only: never in a transcript': 'Update shipping rates', 'Credit note is not a payment': 'Fix refund rounding' };
const retitled = text => Object.entries(TITLES).reduce((t, [from, to]) => t.replaceAll(from, to), text);

export const freePort = () => new Promise((ok, fail) => {
    const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
        const { port } = /** @type {import('node:net').AddressInfo} */ (s.address());
        s.close(() => ok(port));
    });
});

/** Builds the demo's files under tmp. Returns the fixture HOME and env(port), the environment its server runs with. */
export function buildDemo(tmp) {

    const { home, bin } = buildFixture(tmp);
    const data = join(tmp, 'homebase');

    writeFileSync(join(tmp, 'forge-stub.mjs'), retitled(readFileSync(join(FIXTURES, 'forge-stub.mjs'), 'utf8')).replace("'./fixture.mjs'", JSON.stringify(join(FIXTURES, 'fixture.mjs'))));
    for (const cli of ['glab', 'gh']) {
        writeFileSync(join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${join(tmp, 'forge-stub.mjs')}" ${cli} "$@"\n`, { mode: 0o755 });
    }
    writeFileSync(join(data, 'items.json'), retitled(readFileSync(join(data, 'items.json'), 'utf8')));
    writeFileSync(join(data, 'tracked.json'), '["alpha","beta","gamma"]'); // the board's projects on a first visit
    const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
    config.newProject.baseDir = '~/code';
    writeFileSync(join(data, 'config.json'), JSON.stringify(config));

    // the tests' failure cases a first look shouldn't lead with: the chat's API error line and the stopped subagent
    const chats = join(home, '.claude', 'projects', '-fx-alpha');
    const master = join(chats, `${IDS.master}.jsonl`), { mtime } = statSync(master);
    writeFileSync(master, readFileSync(master, 'utf8').split('\n').filter(l => !l.includes('"isApiErrorMessage":true')).join('\n'));
    utimesSync(master, mtime, mtime); // a chat's state depends on its file's age
    for (const ext of ['jsonl', 'meta.json']) {
        rmSync(join(chats, IDS.master, 'subagents', `agent-stopped.${ext}`));
    }

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

    // stand-ins for the files the server watches for "restart me", so editing the real code never nags the demo
    const code = join(tmp, 'code');
    for (const f of ['server.mjs', 'server/rules.mjs', 'public/styles.css']) {
        mkdirSync(join(code, f, '..'), { recursive: true });
        writeFileSync(join(code, f), '');
    }
    const env = port => {
        const e = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PORT: String(port), HOMEBASE_DIR: data, HOMEBASE_STATUSLINE_DIR: join(tmp, 'statusline'),
            HOMEBASE_TMUX_SOCKET: `homebase-demo-${process.pid}`, HOMEBASE_STUB_LOG: join(tmp, 'forge.log'), HOMEBASE_CODE_DIR: code };
        delete e.HOMEBASE_LAN;

        return e;
    };

    return { home, env };
}

/** `node server.mjs --demo`: serves the demo until Ctrl+C, then removes its temp dir. Never returns. */
export async function runDemo() {

    const tmp = mkdtempSync(join(tmpdir(), 'homebase-demo-'));
    let server;
    process.on('exit', () => {
        server?.kill();
        rmSync(tmp, { recursive: true, force: true });
    });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => process.exit(0));
    }
    const port = await freePort(); // never 4321, where your own Homebase may run
    server = spawn(process.execPath, [join(REPO, 'server.mjs')], { cwd: REPO, env: { ...buildDemo(tmp).env(port), HOMEBASE_DEMO: '1' }, stdio: 'inherit' });
    server.on('exit', code => process.exit(code ?? 1));
    console.log(`Demo with invented data (nothing is sent to Claude); Ctrl+C stops it and removes ${tmp}`);
    await new Promise(() => {});
}
