// Work helpers as their own chats: `homebase helper start` (bin/homebase.mjs) asks the server to start a separate Claude in
// its own cc-<id8> tmux and, by default, its own worktree on helper/<slug> from the parent chat's HEAD. The registry
// (`helpers` in tmux.mjs, so a resume keeps the rule and model) is kept in helpers.json in the Homebase dir.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { join, basename, dirname } from 'node:path';
import { keepAside } from './account.mjs';
import { slug } from './items.mjs';
import { tmux, tmuxName, claudeLine, loginShell, quoted, helpers, withLock, MAX_SEND, rulesFile } from './tmux.mjs';
import { trustNewProject } from './startup.mjs';
import { splitTldr } from './summaries.mjs';

const run = promisify(execFile);
const gitRun = (args) => run('git', args, { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
export const PER_PARENT = 4, TOTAL = 8;
const MAX = 500;
const ID = /^[0-9a-f-]{36}$/;
const REF = /^(?!-)[\w./~^@-]{1,100}$/; // a branch or base ref: no leading dash, so never a git option
const MODEL = /^[\w.-]{1,40}$/;
const TITLE = /^[^\x00-\x1f\x7f]{1,80}$/;

const bad = (status, message, extra) => Object.assign(new Error(message), { status }, extra);
export const running = () => [...helpers.values()].filter(h => !h.closedAt);

// At server start: what was saved, or nothing when the file is missing or broken (a broken one is set aside).
export function loadHelpers(dir) {

    let saved;
    try {
        saved = JSON.parse(readFileSync(join(dir, 'helpers.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'helpers.json'), e.message, 'helpers lose their registry');
        }
    }
    helpers.clear();
    for (const h of Array.isArray(saved) ? saved.slice(-MAX) : []) {
        if (ID.test(h?.id ?? '') && ID.test(h.parent ?? '') && typeof h.cwd === 'string' && MODEL.test(h.model ?? '')) {
            helpers.set(h.id, h);
        }
    }
}

async function save(dir) {

    const file = join(dir, 'helpers.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify([...helpers.values()].slice(-MAX)), { mode: 0o600 });
    await rename(tmp, file);
}

// A helper's parent is its chat's tmux, not its session id: /clear gives the chat a new id in the same tmux, and its helpers stay its own.
// Entries from before parentTmux fall back to the tmux named after the parent's id.
export const parentTmux = h => h.parentTmux ?? tmuxName(h.parent);

// The chat now running in tmux `name`: the newest session there, so a /clear successor, not the chat it cleared.
export const chatIn = (list, name) => list.filter(x => x.tmux === name).sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];

// The chat a caller's tmux belongs to: refused outside Homebase's chats and from a helper, so helpers don't start helpers.
export function parentOf(list, name) {

    const s = name ? chatIn(list, name) : null;
    if (!s) {
        throw bad(403, 'run this from a chat Homebase started (its tmux is not one of them)');
    }
    if (helpers.has(s.id)) {
        throw bad(403, 'a helper does not start helpers');
    }

    return s;
}

// A helper by its id, the start of its id (8+), or its slug.
export function findHelper(ref) {

    const r = String(ref ?? '');
    const h = helpers.get(r) ?? (r.length >= 8 && [...helpers.values()].find(x => x.id.startsWith(r))) ?? [...helpers.values()].find(x => x.slug === r);
    if (!h) {
        throw bad(404, `no helper ${r}`);
    }

    return h;
}

// The main checkout of the repo `cwd` is in: the parent of the common git dir. Null outside git or for a bare repo.
async function mainCheckout(git, cwd) {

    const common = await git(['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir']).then(r => r.stdout.trim(), () => '');

    return basename(common) === '.git' ? dirname(common) : null;
}

// Starts a helper for parent session { id, cwd, project } with `brief` as its first message. Over the limits: 429 with the running list.
export async function startHelper(dir, parent, { brief, title, model = 'sonnet', base = null, branch = null, worktree = true },
                                  { tm = tmux, git = gitRun, now = Date.now(), newId = randomUUID, trust = trustNewProject, hex = () => randomBytes(2).toString('hex') } = {}) {

    const text = String(brief ?? '').trim();
    if (!text || text.length > MAX_SEND) {
        throw bad(400, 'the brief (stdin) is empty or too long');
    }
    if (!TITLE.test(title ?? '') || !MODEL.test(model) || (base && !REF.test(base)) || (branch && !REF.test(branch))) {
        throw bad(400, 'bad title, model, base or branch');
    }

    // one start at a time, so two can't both pass the limits
    return withLock('helpers:start', async () => {

        const mine = running().filter(h => parentTmux(h) === parent.tmux);
        if (mine.length >= PER_PARENT || running().length >= TOTAL) {
            const error = `limit reached (${PER_PARENT} per chat, ${TOTAL} in all): stop a helper first`;
            throw bad(429, error, { body: { error, running: running().map(({ id, parent, title, branch }) => ({ id, parent, title, branch })) } });
        }

        const id = newId();
        const s = `${slug(title).slice(0, 40).replace(/-$/, '') || 'helper'}-${hex()}`;
        // the project's main checkout, so a chat that cd'd into a linked worktree doesn't pull its helpers (and their board row) into it
        const main = await mainCheckout(git, parent.cwd);
        let cwd = main ?? parent.cwd, top = null, br = null, from = null;
        if (worktree) {
            top = main ?? (await git(['-C', parent.cwd, 'rev-parse', '--show-toplevel'])).stdout.trim();
            from = base ?? (await git(['-C', parent.cwd, 'rev-parse', 'HEAD'])).stdout.trim();
            br = branch ?? `helper/${s}`;
            cwd = join(top, '.claude', 'worktrees', s);
            await git(['-C', top, 'worktree', 'add', '-b', br, cwd, from]).catch(e => {
                throw bad(409, `git worktree add: ${(e.stderr || e.message).trim().split('\n')[0]}`);
            });
        }

        const name = tmuxName(id);
        // --session-id names the chat up front (cc-<id8> is known before its transcript exists); -n is the row title; the brief is the first message
        try {
            await tm(['new-session', '-d', '-s', name, '-c', cwd, loginShell(), '-lic',
                claudeLine(` --model ${quoted(model)} -n ${quoted(title)} --session-id ${id} -- ${quoted(text)}`, rulesFile(), { helper: true })]);
        } catch (e) {
            if (worktree) { // the fresh, empty worktree and branch go again
                await git(['-C', top, 'worktree', 'remove', cwd]).then(() => git(['-C', top, 'branch', '-d', br])).catch(() => {});
            }
            throw e;
        }
        const h = { id, parent: parent.id, parentTmux: parent.tmux, project: parent.project ?? null, top, cwd, branch: br, base: from, slug: s, title, model, at: now, closedAt: null };
        helpers.set(id, h);
        await save(dir);
        if (worktree) {
            trust(name, cwd).catch(() => {}); // the new worktree's trust dialog; never throws, anything else shows in the chat
        }

        return h;
    });
}

// Closes a helper: its tmux (=cc-<id8>, only a registered helper's), its worktree without --force (changes keep it), and its
// branch only when merged (git branch -d). The transcript and the registry entry stay.
export async function closeHelper(dir, ref, { keepWorktree = false, reason = null } = {}, { tm = tmux, git = gitRun, now = Date.now() } = {}) {

    const h = findHelper(ref);
    const out = { id: h.id, worktree: null, branch: null };
    await tm(['kill-session', '-t', `=${tmuxName(h.id)}`]).catch(() => {}); // already gone: claude exited

    if (h.branch && !keepWorktree) {
        try {
            await git(['-C', h.top, 'worktree', 'remove', h.cwd]);
            out.worktree = 'removed';
        } catch (e) {
            out.worktree = `kept: ${(e.stderr || e.message).trim().split('\n')[0]}`;
        }
        try {
            await git(['-C', h.top, 'branch', '-d', h.branch]);
            out.branch = 'deleted';
        } catch {
            out.branch = 'kept: not merged';
        }
    } else if (h.branch) {
        out.worktree = 'kept';
        out.branch = 'kept';
    }

    h.closedAt ??= now;
    h.closedReason ??= reason ?? 'closed on request';
    h.kept = out.worktree?.startsWith('kept') ? out.worktree : null;
    await save(dir);

    return out;
}

// What `homebase helper read/list/wait` show: the entry plus its chat's state. live: the names of running tmux sessions.
// done: its turn ended (or it closed or exited) and it neither asks nor waits on the user, so a `wait` on it returns.
// A tmux missing within START_MS of the start is the 2 s live-tmux cache not having it yet: starting, not exited.
export const START_MS = 15_000;
export function helperView(h, list, live, now = Date.now()) {

    const s = list.find(x => x.id === h.id);
    const status = h.closedAt ? 'closed' : !live.has(tmuxName(h.id)) ? (now - h.at < START_MS ? 'starting' : 'exited') : !s ? 'starting'
        : s.asking ? 'asking' : s.needsYou ? 'needs you' : s.status;

    return {
        ...h, status, done: ['closed', 'exited', 'idle', 'waiting'].includes(status),
        topic: s?.topic ?? null, now: s?.now ?? null, step: s?.step ?? null, question: s?.question ?? null,
        tldr: splitTldr(s?.lastReply ?? '').tldr, reply: s?.lastReply ?? null, replyAt: s?.lastReplyAt ?? null, lastActivity: s?.lastActivity ?? null
    };
}

// The reaper's rules, so no dead tmux or worktree lingers: which open registered helpers to close, as [{ id, why }].
// Only registered helpers are ever looked at, never other cc-* chats. live: the names of running tmux sessions.
export const PARENT_GONE_MS = 10 * 60_000, IDLE_MS = 30 * 60_000, WAITS_MS = 24 * 3600_000;
export function reapDecisions(registry, list, live, now = Date.now()) {

    const out = [];
    // Nothing loaded yet (just after a server start, or tmux/sessions failed to answer): every helper would look gone or idle.
    if (!list.length || !live.size) {
        return out;
    }
    for (const h of registry.values()) {
        if (h.closedAt) {
            continue;
        }
        const v = helperView(h, list, live, now), since = v.lastActivity ?? list.find(x => x.id === h.id)?.updated ?? null; // never h.at: a helper that ran for an hour isn't idle for it
        const quiet = since == null ? 0 : now - since;
        const parent = chatIn(list, parentTmux(h));
        const parentGone = !live.has(parentTmux(h));
        const why = v.status === 'exited' ? 'its claude exited'
            : parentGone && now - (parent?.lastActivity ?? parent?.updated ?? 0) > PARENT_GONE_MS && !['working', 'starting'].includes(v.status) ? 'its parent chat is gone'
                : ['idle', 'waiting'].includes(v.status) && quiet > IDLE_MS ? 'idle for 30 min'
                    : ['asking', 'needs you'].includes(v.status) && quiet > WAITS_MS ? 'waited on you for 24 h'
                        : null;
        if (why) {
            out.push({ id: h.id, why });
        }
    }

    return out;
}

// Runs the reaper's decisions through closeHelper; a failed close is logged and tried again next time. Returns the closed ids.
export async function reapHelpers(dir, list, live, now = Date.now(), close = (id, why) => closeHelper(dir, id, { reason: `reaper: ${why}` }, { now })) {

    const closed = [];
    for (const { id, why } of reapDecisions(helpers, list, live, now)) {
        try {
            await close(id, why);
            closed.push(id);
            console.log(`helper ${id.slice(0, 8)} closed: ${why}`);
        } catch (e) {
            console.error(`helper ${id.slice(0, 8)}: could not close: ${e.message}`);
        }
    }

    return closed;
}

// What a closed helper's composer says, and a send to it answers.
export const closedNote = h => `Closed — ask the main chat to start a new helper${h.branch ? ` on branch ${h.branch}` : ''}`;

// Board nesting: a registered helper's chat gets parentId (left out of the chat list; Back returns to the parent) and helper,
// and its parent gets it as an agent, so the work-item code nests its row as it does a subagent's; the row carries helperSession.
// A closed helper whose transcript aged out has no row. live: the names of running tmux sessions.
export function nestHelpers(list, live, now = Date.now(), registry = helpers) {

    for (const h of registry.values()) {
        const s = list.find(x => x.id === h.id), parent = chatIn(list, parentTmux(h));
        if (s) {
            s.parentId = parent?.id ?? h.parent;
            s.helper = { closed: h.closedAt ? closedNote(h) : null, tmux: tmuxName(h.id) };
        }
        if (!parent || (!s && h.closedAt)) {
            continue;
        }
        const v = helperView(h, list, live, now), running = !v.done;
        const { tldr, text: body } = splitTldr(s?.lastReply ?? '');
        const waits = v.status === 'asking' || v.status === 'needs you';
        (parent.agents ??= []).push({
            id: h.id, helperSession: h.id, helperClosed: !!h.closedAt, description: h.title,
            status: running ? 'running' : 'done', stopReason: null,
            outcome: running ? null : (tldr || body).split('\n').find(l => l.trim())?.slice(0, 120) ?? null,
            stage: running ? 1 : 4, step: waits ? `Needs you: ${s?.question ?? s?.needsText ?? 'see its chat'}` : s?.step ?? null, stepAt: s?.stepAt ?? null,
            tldr: tldr || null, body, branch: h.branch ?? s?.head ?? null, branches: [...new Set([h.branch, s?.head].filter(Boolean))], prs: (s?.prs ?? []).map(p => p.url),
            worktreePath: h.branch || h.cwd?.includes('/.claude/worktrees/') ? h.cwd : null, files: s?.files ?? [], updated: s?.lastActivity ?? s?.updated ?? h.at, started: h.at
        });
    }
}

// Commits on the helper's branch since its base, for `list`; null without a worktree or once closed.
export const ahead = (h, git = gitRun) => (h.branch && !h.closedAt
    ? git(['-C', h.cwd, 'rev-list', '--count', `${h.base}..HEAD`]).then(r => Number(r.stdout.trim()), () => null)
    : Promise.resolve(null));

// The server's API token in <dir>/token (0600, through a temp file so it is never readable by others), for bin/homebase.mjs.
export function writeToken(dir, token) {

    const file = join(dir, 'token'), tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, token, { mode: 0o600 });
    renameSync(tmp, file);
}
