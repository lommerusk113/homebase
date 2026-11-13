// "New project": create a GitHub repo for the personal account, clone it, and start a Claude chat in it (POST /api/projects/new).
// The token comes from the macOS keychain into memory only: it reaches the gh child process through its env and nowhere else.
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './transcripts.mjs';
import { tmux, sleep } from './tmux.mjs';
import { DEFAULTS, mergeConfig, loadConfig, readToken, scrub as scrubToken } from './account.mjs';

export { DEFAULTS, mergeConfig, loadConfig };

const run = promisify(execFile);

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DESC_MAX = 350;
const STEPS = [['repo', 'Creating repo'], ['clone', 'Cloning'], ['chat', 'Starting chat']];
const TIMEOUT = { gh: 60_000, git: 120_000, tmux: 10_000 };

export const validName = n => typeof n === 'string' && NAME.test(n) && !n.startsWith('.');

// The part of the config the page may know; never the keychain service.
export const publicConfig = (c = loadConfig()) => ({ owner: c.owner, baseDir: c.baseDir.replace(homedir(), '~'), private: c.private });

const transcriptDir = dir => join(ROOT, dir.replace(/[^A-Za-z0-9]/g, '-'));
const listTranscripts = dir => readdir(transcriptDir(dir)).then(fs => fs.filter(f => f.endsWith('.jsonl')), () => []);

const inFlight = new Set();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Runs the three steps. Throws { status, body: { ok: false, steps, error } } when one fails, with a message saying what exists;
// every string that leaves here has the token scrubbed.
export async function createProject(body, deps = {}) {

    const { config = loadConfig(), exec = run, tmux: tm = tmux, exists = existsSync, transcripts = listTranscripts, nap = sleep, waitMs = 20_000 } = deps;
    const { name } = body ?? {};
    const description = String(body?.description ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (!validName(name)) {
        throw bad('Invalid name: use 1-100 letters, digits, ".", "_" or "-", not starting with a dot');
    }
    if (description.length > DESC_MAX) {
        throw bad(`Description is longer than ${DESC_MAX} characters`);
    }

    const { owner, sshHost, keychainService } = config;
    const dir = join(config.baseDir, name), repo = `${owner}/${name}`;
    if (exists(dir)) {
        throw bad(`${dir} already exists`);
    }
    if (inFlight.has(name)) {
        throw bad(`${name} is already being created`, 409);
    }
    inFlight.add(name);

    let token = null;
    const scrub = s => scrubToken(s, token);
    const steps = STEPS.map(([id, label]) => ({ id, label, state: 'pending' }));
    const fail = (i, e, what) => {
        const detail = scrub(e?.stderr?.trim() || (e?.killed ? 'timed out' : e?.message) || 'failed');
        const error = `${what ? `${what} ` : ''}${detail}`;
        steps[i].state = 'failed';
        steps[i].error = detail;

        return Object.assign(new Error(error), { status: 502, body: { ok: false, steps, error } });
    };

    try {
        // a. token, in memory only
        try {
            token = await readToken(keychainService, exec, 0);
        } catch (e) {
            throw fail(0, e);
        }

        // b. nothing else happens if this fails
        const env = { ...process.env, GH_TOKEN: token };
        delete env.GITHUB_TOKEN;
        const visibility = (body.private ?? config.private) ? '--private' : '--public';
        const args = ['repo', 'create', repo, visibility, ...(description ? ['--description', description] : []), '--add-readme'];
        try {
            await exec('gh', args, { env, timeout: TIMEOUT.gh });
        } catch (e) {
            throw fail(0, e);
        }
        steps[0].state = 'done';
        const made = `github.com/${repo} was created`;

        // c.
        try {
            await exec('git', ['clone', `git@${sshHost}:${repo}.git`, dir], { timeout: TIMEOUT.git, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        } catch (e) {
            throw fail(1, e, `${made}, but cloning to ${dir} failed, so nothing is cloned:`);
        }
        steps[1].state = 'done';

        // d. the session id is only known once Claude has written its transcript
        const tmuxName = `cc-new-${name}`;
        try {
            await tm(['new-session', '-d', '-s', tmuxName, '-c', dir, 'zsh', '-lic', 'claude']);
        } catch (e) {
            throw fail(2, e, `${made} and cloned to ${dir}, but starting Claude failed:`);
        }
        steps[2].state = 'done';

        let sessionId = null;
        for (let t = 0; t < waitMs && !sessionId; t += 500) {
            sessionId = (await transcripts(dir))[0]?.replace(/\.jsonl$/, '') ?? null;
            if (!sessionId) {
                await nap(500);
            }
        }

        return { ok: true, name, repo, dir, tmux: tmuxName, sessionId, steps };
    } finally {
        inFlight.delete(name);
    }
}
