// Which GitHub account a repo's gh calls run as. The work account is the user's own gh login (GITHUB_TOKEN); personal
// repos (origin via the configured SSH host alias, or owned by the configured owner) run as the keychain token instead.
// The token lives in memory only: it reaches the gh child through its env and nowhere else, and errors are scrubbed.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

export const DEFAULTS = { owner: 'lommerusk113', keychainService: 'gh-personal', sshHost: 'github-personal', baseDir: '~/IdeaProjects/Privat', private: true };
const CONFIG_FILE = () => join(process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase'), 'config.json');
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/; // owner, service and host end up in argv and an ssh URL
export const TOKEN_TTL_MS = 600_000;
const CONFIG_TTL_MS = 30_000;
const KEYCHAIN_TIMEOUT_MS = 10_000;

export const repoPaths = new Map(); // repo name -> { host, path }, from the origin URL

// File values override the defaults, key by key; a value of the wrong type or an unsafe string is an error, not ignored.
export function mergeConfig(file) {

    const given = file?.newProject ?? {};
    const c = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) {
        if (given[k] === undefined) {
            continue;
        }
        if (typeof given[k] !== typeof DEFAULTS[k] || (k !== 'baseDir' && typeof given[k] === 'string' && !SAFE.test(given[k]))) {
            throw Object.assign(new Error(`config.json: newProject.${k} is not valid`), { status: 500 });
        }
        c[k] = given[k];
    }
    c.baseDir = c.baseDir.replace(/^~(?=\/|$)/, homedir());

    return c;
}

export function loadConfig(path = CONFIG_FILE()) {

    let file;
    try {
        file = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            throw Object.assign(new Error('config.json is not valid JSON'), { status: 500 });
        }
    }

    return mergeConfig(file);
}

// The config for forge calls, re-read every 30 s; null when it is invalid, which leaves every repo on the work account.
let config = { at: 0, value: null };
function forgeConfig() {

    if (Date.now() - config.at > CONFIG_TTL_MS) {
        try {
            config = { at: Date.now(), value: loadConfig() };
        } catch {
            config = { at: Date.now(), value: null };
        }
    }

    return config.value;
}

// 'personal' or 'work' for a repo { host, path }; GitLab hosts are always work.
export function accountOf(repo, cfg = forgeConfig()) {

    const owner = repo?.path?.split('/')[0]?.toLowerCase();
    const personal = cfg && !/gitlab/.test(repo.host) && (repo.host === cfg.sshHost || (owner && owner === cfg.owner.toLowerCase()));

    return personal ? 'personal' : 'work';
}

// The keychain token of a service, read at most once per ttl (concurrent callers share the read; failures are never kept).
// ttl 0 always reads fresh.
const tokens = new Map(); // service -> { at, pending }
export function readToken(service, exec = run, ttl = TOKEN_TTL_MS) {

    const hit = tokens.get(service);
    if (ttl && hit && Date.now() - hit.at < ttl) {
        return hit.pending;
    }

    const pending = exec('security', ['find-generic-password', '-s', service, '-w'], { timeout: KEYCHAIN_TIMEOUT_MS }).then(({ stdout }) => {
        const token = stdout.trim();
        if (!token) {
            throw new Error('empty');
        }

        return token;
    }).catch(() => {
        tokens.delete(service);
        throw new Error(`could not read keychain item "${service}"`);
    });
    if (ttl) {
        tokens.set(service, { at: Date.now(), pending });
    }

    return pending;
}

export const scrub = (s, token) => (token ? String(s).split(token).join('[token]') : String(s));

// Runs gh for a repo as its account and returns { stdout }. A personal repo gets GH_TOKEN and no GITHUB_TOKEN; when the
// keychain can't be read the call runs as today and, if it fails, the keychain error leads its message.
export async function ghRun(repo, args, opts = {}, exec = run) {

    const cfg = forgeConfig();
    let token = null, keychainError = null;
    if (accountOf(repo, cfg) === 'personal') {
        try {
            token = await readToken(cfg.keychainService, exec);
        } catch (e) {
            keychainError = e;
        }
    }

    try {
        if (!token) {
            return await exec('gh', args, opts);
        }
        const env = { ...process.env, GH_TOKEN: token };
        delete env.GITHUB_TOKEN;

        return await exec('gh', args, { ...opts, env });
    } catch (e) {
        for (const k of ['message', 'stderr', 'stdout', 'cmd']) {
            if (typeof e[k] === 'string') {
                e[k] = scrub(e[k], token);
            }
        }
        if (keychainError) {
            e.message = `${keychainError.message}; ${e.message}`;
        }
        throw e;
    }
}
