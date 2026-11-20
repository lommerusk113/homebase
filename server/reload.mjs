// Update without manual restarts: notice when Homebase's own code changed on disk, and replace this server with a fresh one.
import { readdir, stat } from 'node:fs/promises';
import { openSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// The tree whose mtimes count: this checkout, or HOMEBASE_CODE_DIR so tests touch a stand-in instead of the shared files.
const root = () => process.env.HOMEBASE_CODE_DIR ?? HERE;

// Paths in dir (relative to the repo) whose name ends in one of exts.
const filesIn = async (dir, exts) => (await readdir(join(root(), dir))).filter(f => exts.some(e => f.endsWith(e))).map(f => join(root(), dir, f));
// whole ms: a file whose mtime was set back through a Date (ms precision) reads as unchanged
const mtimes = paths => Promise.all(paths.map(p => stat(p).then(st => Math.floor(st.mtimeMs), () => 0)));

// Newest mtime of the server's own code: server.mjs and server/*.mjs.
export const serverMtime = async () => Math.max(...await mtimes([join(root(), 'server.mjs'), ...await filesIn('server', ['.mjs'])]));
// A short hash of public/*.js and *.css mtimes: it changes when a browser file changes, without a restart.
export const pageHash = async () => {
    const files = (await filesIn('public', ['.js', '.css'])).sort();
    return createHash('sha1').update((await mtimes(files)).join(',')).digest('base64url').slice(0, 12);
};
// Pure: code newer than what this process loaded at start.
export const isStale = (startMtime, nowMtime) => nowMtime > startMtime;

const startMtime = serverMtime();

// GET /api/version: pid tells a replaced server apart; page changes whenever a browser file does.
export async function version() {

    return { pid: process.pid, serverStale: isStale(await startMtime, await serverMtime()), page: await pageHash() };
}

const listening = port => new Promise(ok => {
    const s = connect(port, '127.0.0.1', () => { s.destroy(); ok(true); }).on('error', () => ok(false));
});

// Replace this process: spawn a detached `node server.mjs` with the same argv, cwd and env (it retries binding while
// the ports free), close the listeners, and exit once the child answers on port. If the child dies first (broken new
// code), listen again and keep running. Never touches any other process.
export function replaceSelf(servers, port, logFile) {

    mkdirSync(dirname(logFile), { recursive: true });
    const out = openSync(logFile, 'a');
    const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    let failed = false;
    child.on('exit', code => {
        failed = true;
        console.error(`reload: the new server exited (${code}) before listening; see ${logFile}. Keeping this one.`);
        servers.forEach(([s, p]) => s.listen(p, '127.0.0.1'));
    });
    servers.forEach(([s]) => {
        s.close();
        s.closeIdleConnections();
    });
    const wait = async () => {
        while (!failed) {
            if (await listening(port)) {
                console.log(`reload: replaced by pid ${child.pid}`);
                process.exit(0);
            }
            await new Promise(r => setTimeout(r, 200));
        }
    };
    wait();
}

// Listen, retrying for a few seconds while a replaced server frees the port.
export function listenRetry(server, port, done, tries = 25) {

    server.once('error', e => {
        if (e.code !== 'EADDRINUSE' || tries <= 0) {
            throw e;
        }
        setTimeout(() => listenRetry(server, port, done, tries - 1), 200);
    });
    server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        done();
    });
}
