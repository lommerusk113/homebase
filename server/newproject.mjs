// "New project": create a GitHub repo for the personal account, clone it, and start a Claude chat in it (POST /api/projects/new);
// or start one in a folder that is already there (POST /api/projects/open).
// The token comes from the macOS keychain into memory only: it reaches the gh child process through its env and nowhere else.
import { existsSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, isAbsolute, sep } from 'node:path';
import { ROOT, liveSessions } from './entries.mjs';
import { tmux, sleep, claudeLine, liveTmux } from './tmux.mjs';
import { sessions, projectOf } from './sessions.mjs';
import { trustNewProject } from './startup.mjs';
import { DEFAULTS, mergeConfig, loadConfig, tokenFor, ghEnv, resolveOwner, scrub as scrubToken } from './account.mjs';

export { DEFAULTS, mergeConfig, loadConfig };

const run = promisify(execFile);

const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DESC_MAX = 350;
const STEPS = [['clone', 'Cloning'], ['chat', 'Starting chat']];
const CREATE_STEPS = [['repo', 'Creating repo'], ...STEPS];
const LIST_TTL_MS = 60_000;
const TIMEOUT = { gh: 60_000, git: 120_000, tmux: 10_000 };

export const validName = n => typeof n === 'string' && NAME.test(n) && !n.startsWith('.');

// The part of the config the page may know; never the keychain service.
export const publicConfig = async (c = loadConfig(), exec = run) => ({ owner: await resolveOwner(c, exec).catch(() => ''), baseDir: c.baseDir.replace(homedir(), '~'), private: c.private });

const transcriptDir = dir => join(ROOT, dir.replace(/[^A-Za-z0-9]/g, '-'));
const listTranscripts = dir => readdir(transcriptDir(dir)).then(fs => fs.filter(f => f.endsWith('.jsonl')), () => []);

const inFlight = new Set();
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// A failing step: marks it, and makes the error the route sends as { ok: false, steps, error }.
const failer = (steps, scrub = s => s) => (i, e, what) => {
    const detail = scrub(e?.stderr?.trim() || (e?.killed ? 'timed out' : e?.message) || 'failed');
    const error = `${what ? `${what} ` : ''}${detail}`;
    steps[i].state = 'failed';
    steps[i].error = detail;

    return Object.assign(new Error(error), { status: 502, body: { ok: false, steps, error } });
};

// Clone, start the chat, wait for its session id; `i` is the index of the Cloning step, `made` says what was done before
// (e.g. "github.com/o/n was created"; empty when nothing was).
async function cloneAndStart(c, i, made) {

    const { dir, repo, sshHost, steps, fail, exec } = c;
    try {
        await exec('git', ['clone', `git@${sshHost}:${repo}.git`, dir], { timeout: TIMEOUT.git, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
        throw fail(i, e, made ? `${made}, but cloning to ${dir} failed, so nothing is cloned:` : `Cloning to ${dir} failed, so nothing is cloned:`);
    }
    steps[i].state = 'done';

    return { ...await startChat(c, i + 1, made ? `${made} and cloned to ${dir}, but starting Claude failed:` : `Cloned to ${dir}, but starting Claude failed:`), repo };
}

// The start-chat step: Claude in tmux cc-new-<name> in dir, then wait for its session id; step `i`, `what` heads its error.
async function startChat(c, i, what) {

    const { name, dir, steps, fail, tm, nap, transcripts, waitMs, trustMs, before = new Set() } = c; // before: an existing folder's older sessions

    // the session id is only known once Claude has written its transcript
    const tmuxName = `cc-new-${name}`;
    try {
        await tm(['new-session', '-d', '-s', tmuxName, '-x', '200', '-y', '50', '-c', dir, 'zsh', '-lic', claudeLine()]);
    } catch (e) {
        throw fail(i, e, what);
    }
    steps[i].state = 'done';

    await trustNewProject(tmuxName, dir, { tm, nap, waitMs: trustMs }); // never throws; other startup prompts show in the chat

    let sessionId = null;
    for (let t = 0; t < waitMs && !sessionId; t += 500) {
        sessionId = (await transcripts(dir)).find(f => !before.has(f))?.replace(/\.jsonl$/, '') ?? null;
        if (!sessionId) {
            await nap(500);
        }
    }

    return { ok: true, name, dir, tmux: tmuxName, sessionId, steps };
}

// Runs the three steps. Throws { status, body: { ok: false, steps, error } } when one fails, with a message saying what exists;
// every string that leaves here has the token scrubbed.
export async function createProject(body, deps = {}) {

    const { config = loadConfig(), exec = run, tmux: tm = tmux, exists = existsSync, transcripts = listTranscripts, nap = sleep, waitMs = 20_000, trustMs = 60_000 } = deps;
    const { name } = body ?? {};
    const description = String(body?.description ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    if (!validName(name)) {
        throw bad('Invalid name: use 1-100 letters, digits, ".", "_" or "-", not starting with a dot');
    }
    if (description.length > DESC_MAX) {
        throw bad(`Description is longer than ${DESC_MAX} characters`);
    }

    const { sshHost } = config;
    const owner = await resolveOwner(config, exec);
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
    const steps = CREATE_STEPS.map(([id, label]) => ({ id, label, state: 'pending' }));
    const fail = failer(steps, scrub);
    const ctx = { name, dir, repo, sshHost, steps, fail, exec, tm, nap, transcripts, waitMs, trustMs };

    try {
        // a. token, in memory only
        try {
            token = await tokenFor(config, exec);
        } catch (e) {
            throw fail(0, e);
        }

        // b. nothing else happens if this fails
        const env = ghEnv(token);
        const visibility = (body.private ?? config.private) ? '--private' : '--public';
        const args = ['repo', 'create', repo, visibility, ...(description ? ['--description', description] : []), '--add-readme'];
        try {
            await exec('gh', args, { env, timeout: TIMEOUT.gh });
        } catch (e) {
            throw fail(0, e);
        }
        steps[0].state = 'done';
        const made = `github.com/${repo} was created`;

        return await cloneAndStart(ctx, 1, made);
    } finally {
        inFlight.delete(name);
    }
}

const fresh = new Map(); // owner -> { at, repos }

// The owner's repos, newest first, archived left out (gh as the personal account, like createProject); cached for a minute.
export async function listRepos(deps = {}) {

    const { config = loadConfig(), exec = run, ttl = LIST_TTL_MS } = deps;
    const owner = await resolveOwner(config, exec);
    const hit = fresh.get(owner);
    if (ttl && hit && Date.now() - hit.at < ttl) {
        return hit.repos;
    }

    let token = null, repos;
    try {
        token = await tokenFor(config, exec);
        const env = ghEnv(token);
        const { stdout } = await exec('gh', ['repo', 'list', owner, '--limit', '200', '--json', 'name,description,isPrivate,updatedAt,isArchived'], { env, timeout: TIMEOUT.gh });
        repos = JSON.parse(stdout).filter(r => !r.isArchived && validName(r.name)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .map(({ name, description, isPrivate, updatedAt }) => ({ name, description: description ?? '', isPrivate, updatedAt }));
    } catch (e) {
        const detail = scrubToken(e?.stderr?.trim() || (e?.killed ? 'timed out' : e?.message) || 'failed', token);
        throw Object.assign(new Error(`Could not list repos: ${detail}`), { status: 502 });
    }
    fresh.set(owner, { at: Date.now(), repos });

    return repos;
}

// GET /api/projects/github: the list, each marked with whether its folder already exists.
export async function githubProjects(deps = {}) {

    const { config = loadConfig(), exists = existsSync } = deps;

    return (await listRepos({ ...deps, config })).map(r => ({ ...r, local: exists(join(config.baseDir, r.name)), dir: join(config.baseDir, r.name) }));
}

// POST /api/projects/clone: clone one of the owner's repos (the name must be in gh's list) and start a chat in it.
export async function cloneProject(body, deps = {}) {

    const { config = loadConfig(), exec = run, tmux: tm = tmux, exists = existsSync, transcripts = listTranscripts, nap = sleep, waitMs = 20_000, trustMs = 60_000 } = deps;
    const name = body?.name;
    if (!validName(name)) {
        throw bad('Invalid name: use 1-100 letters, digits, ".", "_" or "-", not starting with a dot');
    }
    const dir = join(config.baseDir, name);
    if (exists(dir)) {
        throw bad(`${dir} already exists`);
    }
    const owner = await resolveOwner(config, exec);
    if (!(await listRepos({ ...deps, config })).some(r => r.name === name)) {
        throw bad(`${owner} has no repo named ${name}`, 404);
    }
    if (inFlight.has(name)) {
        throw bad(`${name} is already being created`, 409);
    }
    inFlight.add(name);

    const steps = STEPS.map(([id, label]) => ({ id, label, state: 'pending' }));
    const fail = failer(steps);

    try {
        return await cloneAndStart({ name, dir, repo: `${owner}/${name}`, sshHost: config.sshHost, steps, fail, exec, tm, nap, transcripts, waitMs, trustMs }, 0, '');
    } finally {
        inFlight.delete(name);
    }
}

const real = p => realpath(p).catch(() => null);
const within = (path, root) => path.startsWith(root.endsWith(sep) ? root : root + sep);

// Where Open may start Claude: an existing folder whose real path (symlinks and ".." resolved) is inside baseDir, not baseDir
// itself, or is the cwd of a known session. Returns that real path; throws 400 for a bad path, 403 for one outside.
export async function allowedDir(dir, { baseDir, cwds = [] }) {

    if (typeof dir !== 'string' || !isAbsolute(dir) || dir.length > 1024 || /[\x00-\x1f\x7f]/.test(dir)) {
        throw bad('Expected an absolute folder path');
    }
    const path = await real(dir);
    if (!path || !(await stat(path)).isDirectory()) {
        throw bad(`${dir} is not a folder`);
    }

    const base = await real(baseDir);
    if (!(base && within(path, base)) && !(await Promise.all(cwds.filter(c => typeof c === 'string').map(real))).includes(path)) {
        throw bad(`${dir} is not in ${baseDir} or a folder Claude has run in`, 403);
    }

    return path;
}

const knownCwds = async () => (await sessions()).map(s => s.cwd);

// The tmux name part (NEW_TMUX) for a project name; the page's starting chat is cc-new-<its project name>.
const tmuxSafe = n => n.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'project';

// POST /api/projects/open { dir }: only the start-chat step, in a folder that is already there. name is the project's
// name as the board knows it (its git repo, else the folder).
export async function openProject(body, deps = {}) {

    const { config = loadConfig(), cwds = knownCwds, project = projectOf, tmux: tm = tmux, transcripts = listTranscripts, nap = sleep, waitMs = 20_000, trustMs = 60_000 } = deps;
    const dir = await allowedDir(body?.dir, { baseDir: config.baseDir, cwds: await cwds() });
    if (inFlight.has(dir)) {
        throw bad(`${dir} is already being opened`, 409);
    }
    inFlight.add(dir);

    const steps = [{ id: 'chat', label: 'Starting chat', state: 'pending' }];
    try {
        const name = tmuxSafe(await project(dir)), before = new Set(await transcripts(dir));
        return { ...await startChat({ name, dir, steps, fail: failer(steps), tm, nap, transcripts, waitMs, trustMs, before }, 0, `Starting Claude in ${dir} failed:`), repo: null };
    } finally {
        inFlight.delete(dir);
    }
}

// GET /api/projects/local: the git repos directly under baseDir, most recently used first (by .git's mtime), leaving out
// any a running Claude or a tmux session already works in.
export async function localProjects(deps = {}) {

    const { config = loadConfig(), busy = busyDirs } = deps;
    const taken = await busy();
    const names = await readdir(config.baseDir).catch(() => []);
    const repos = await Promise.all(names.filter(n => !n.startsWith('.')).map(async name => {
        const dir = join(config.baseDir, name);
        const git = await stat(join(dir, '.git')).catch(() => null);
        return git && !taken.some(t => t === dir || within(t, dir)) ? { name, dir, updated: git.mtimeMs } : null;
    }));

    return repos.filter(Boolean).sort((a, b) => b.updated - a.updated);
}

// Folders with a live Claude: sessions whose process runs, and every tmux session's start dir.
async function busyDirs() {

    const live = await liveSessions();

    return [...(await sessions()).filter(s => s.cwd && live?.has(s.id)).map(s => s.cwd), ...(await liveTmux()).map(l => l.path)];
}
