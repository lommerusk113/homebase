// The session list: repo names, subagent summaries and status, session summaries, and sessions(), which joins them with
// PR/MR state, work items and /clear aliases for GET /api/sessions.
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, WORKING_MS, cache, readTail, tailOf, textOf, isHumanPrompt, EDIT_TOOLS, PR_URL, filesTouched, splitTldr, gateRuns, turnState, turnPrompts, readUsage, latestTopic, queuedPrompts, spawnPrompts } from './transcripts.mjs';
import { PR_TTL_MS, prState, swrEntry, fetchComments, withThreads, swr } from './forge.mjs';
import { workItems, milestoneOf } from './items.mjs';
import { aliases, clears, CLEAR_WAIT_MS, tmuxFor, findClearedSuccessor } from './tmux.mjs';

const run = promisify(execFile);

const MAX_AGE_MS = Number(process.env.MAX_AGE_DAYS ?? 3) * 864e5;
const WAITING_MS = 30 * 60_000;
const FINISHED_MS = 2 * 3600_000; // a finished subagent counts on the Sessions strip this long
const AGENT_TAIL_BYTES = 128 * 1024;
// Silence an unfinished subagent may keep before it counts as stopped, by what its transcript ends on.
const AGENT_TOOL_MS = 30 * 60_000; // a tool call is still pending (long Bash, own background subagent)
const AGENT_THINK_MS = 10 * 60_000; // last entry is a tool result or user message, so the model is thinking
const AGENT_IDLE_MS = 2 * 60_000; // ended its turn with text but never handed back

const projects = new Map(); // cwd -> repo name
export const repoPaths = new Map(); // repo name -> { host, path }, from the origin URL

// Main repo name, so worktrees group under their repo. Read-only git call.
export function repoName(url) {

    const name = basename(url.trim().replace(/\.git$/, '').replace(/^.*:/, ''));
    if (!name) {
        throw new Error('no repo name');
    }

    return name;
}

// Host and full project path of an origin URL: git@gitlab.com:tritt/accounting/pracsys.git -> { host: 'gitlab.com', path: 'tritt/accounting/pracsys' }.
export function repoPath(url) {

    const m = url.trim().replace(/\.git$/, '').replace(/\/$/, '').match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+)$/);

    return m ? { host: m[1], path: m[2] } : null;
}

export async function projectOf(cwd) {

    if (!cwd) {
        return '—';
    }
    if (!projects.has(cwd)) {
        // repo name from origin (so a folder named differently still shows the real repo), else the main checkout's folder
        projects.set(cwd, run('git', ['-C', cwd, 'remote', 'get-url', 'origin'])
            .then(({ stdout }) => {
                const name = repoName(stdout);
                const repo = repoPath(stdout);
                if (repo) {
                    repoPaths.set(name, repo);
                }

                return name;
            })
            .catch(() => run('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
                .then(({ stdout }) => basename(dirname(stdout.trim()))))
            .catch(() => basename(cwd.replace(/\/\.(claude\/)?worktrees\/.*$/, ''))));
    }

    return projects.get(cwd);
}

const STAGES = ['Explore', 'Implement', 'Verify', 'Ship', 'Done'];
// Matched against each command of a Bash call, so they are anchored to its start.
const VERIFY_CMD = /^(?:\S*gradlew?\b.*\b(?:check|test)\b|(?:npx |pnpm |yarn |bunx? )?(?:vitest|jest|tsc|eslint)\b|(?:npm|pnpm|yarn|bun) (?:run )?(?:test|check|lint|typecheck)\b|node (?:--test|\S*test)|mvn\b.*\b(?:test|verify)\b)/;
const SHIP_CMD = /^(?:git push|glab mr create|gh pr create)\b/;
const stagePeak = new Map(); // agent id -> highest stage seen, since old edits fall out of the tail

// ponytail: heredoc bodies and quoted strings are dropped, then split on && ; | and newlines; $(...) and backslash-continued lines are not parsed
export function runs(cmd, re) {

    const code = cmd
        .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1\b/g, '')
        .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");

    return code.split(/&&|\|\|?|;|\n/).some(c => re.test(c.trim()));
}

// ponytail: stage is guessed from tool calls in the tail (subagents rarely keep todo lists)
export function agentStage(uses, report, done) {

    if (done) {
        return 4;
    }

    let stage = report.match(PR_URL) ? 3 : 0;
    for (const u of uses) {
        const cmd = u.name === 'Bash' ? u.input?.command ?? '' : '';
        if (runs(cmd, SHIP_CMD)) {
            stage = 3;
        } else if (runs(cmd, VERIFY_CMD)) {
            stage = Math.max(stage, 2);
        } else if (EDIT_TOOLS.has(u.name)) {
            stage = Math.max(stage, 1);
        }
    }

    return stage;
}

const LAUNCHED = /Command running in background with ID: (\w+)|Async agent launched successfully[\s\S]*?agentId: (\w+)/;
const NOTIFIED = /<task-notification>\s*<task-id>(\w+)<\/task-id>/;

// Background commands and subagents the agent launched that haven't sent their task notification yet.
// ponytail: only the parsed tail; a launch older than it is missed
export function backgroundTasks(entries) {

    const open = new Set();
    for (const e of entries) {
        const blocks = e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : [];
        for (const b of blocks.filter(b => b.type === 'tool_result')) {
            const m = (typeof b.content === 'string' ? b.content : textOf({ message: { content: b.content } })).match(LAUNCHED);
            if (m) {
                open.add(m[1] ?? m[2]);
            }
        }
        const told = e.type === 'attachment' && e.attachment?.type === 'queued_command' ? textOf({ message: { content: e.attachment.prompt } }) : e.type === 'user' ? textOf(e) : '';
        open.delete(told.match(NOTIFIED)?.[1]);
    }

    return open;
}

// Status from the transcript tail: pending tool calls and thinking may be silent for long; an API error stops it at once.
// meta.finished flips when the agent ends its turn, even while it waits on its own background work to resume it.
export function agentStatus(meta, entries, ageMs) {

    const waiting = backgroundTasks(entries).size > 0;
    if (meta.finished) {
        return { status: waiting && ageMs < AGENT_TOOL_MS ? 'running' : 'done' };
    }

    const turns = entries.filter(e => e.type === 'assistant' || e.type === 'user');
    const last = turns.at(-1);
    if (last?.isApiErrorMessage) {
        return { status: 'stopped', stopReason: 'api-error' };
    }

    const pending = new Set();
    let prev;
    for (const e of turns) {
        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.type === 'assistant') {
            if (prev === 'user') {
                pending.clear();
            }
            blocks.filter(b => b.type === 'tool_use').forEach(b => pending.add(b.id));
        } else {
            blocks.filter(b => b.type === 'tool_result').forEach(b => pending.delete(b.tool_use_id));
        }
        prev = e.type;
    }

    const limit = pending.size || waiting ? AGENT_TOOL_MS : last?.type === 'assistant' ? AGENT_IDLE_MS : AGENT_THINK_MS;

    return { status: ageMs < limit ? 'running' : 'stopped' };
}

export function summarizeAgent(meta, entries, ageMs, id) {

    const uses = entries.flatMap(e => (e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : []))
        .filter(b => b.type === 'tool_use');
    const handback = uses.findLast(b => b.name === 'SubagentHandback')?.input?.message;
    const report = handback ?? textOf(entries.findLast(e => e.type === 'assistant' && textOf(e))) ?? '';
    const { status, stopReason } = agentStatus(meta, entries, ageMs);
    const { tldr, text: body } = splitTldr(report);
    const stage = Math.max(agentStage(uses, report, status === 'done'), stagePeak.get(id) ?? 0);
    if (id) {
        stagePeak.set(id, stage);
    }

    return {
        description: meta.description ?? meta.agentType,
        status,
        stopReason,
        stage,
        stageLabel: STAGES[stage],
        report,
        tldr,
        body,
        pr: report.match(PR_URL)?.at(-1) ?? null,
        prs: [...new Set(report.match(PR_URL))],
        branch: entries.findLast(e => e.gitBranch)?.gitBranch ?? meta.worktreeBranch ?? null,
        worktreePath: meta.worktreePath ?? null,
        model: entries.findLast(e => e.type === 'assistant')?.message?.model ?? meta.pickedEffortModel ?? null,
        files: filesTouched(entries, meta.worktreePath ?? entries.findLast(e => e.cwd)?.cwd),
        gates: gateRuns(entries, `${meta.description ?? ''}\n${textOf(entries.find(e => e.type === 'user'))}`)
    };
}

// The branch checked out in a git worktree, from its `.git` file and HEAD; null when gone or detached.
async function worktreeHead(path) {

    try {
        const gitdir = (await readFile(join(path, '.git'), 'utf8')).trim().replace(/^gitdir: /, '');
        return (await readFile(join(gitdir, 'HEAD'), 'utf8')).match(/^ref: refs\/heads\/(.+)/)?.[1] ?? null;
    } catch {
        return null;
    }
}

const prompts = new Map(); // subagent transcript path -> its first prompt, which falls out of the tail
const PROMPT_BYTES = 32 * 1024;

// A subagent's prompt is its transcript's first line; a longer line is kept as raw JSON, which still holds the refs.
async function firstPrompt(path) {

    if (!prompts.has(path)) {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(PROMPT_BYTES);
            const { bytesRead } = await fh.read(buf, 0, PROMPT_BYTES, 0);
            const line = buf.toString('utf8', 0, bytesRead).split('\n')[0];
            let text;
            try {
                text = textOf(JSON.parse(line));
            } catch {
                text = line;
            }
            prompts.set(path, text);
        } finally {
            await fh.close();
        }
    }

    return prompts.get(path);
}

// A subagent's .meta.json, or fallback (the last good one) while it is half-written or gone.
async function readMeta(path, fallback) {

    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch {
        return fallback;
    }
}

// Background subagents a master session started (depth 1 only; their own helpers are noise).
async function agents(sessionDir, now) {

    let names;
    try {
        names = (await readdir(sessionDir)).filter(f => f.endsWith('.meta.json'));
    } catch {
        return [];
    }

    const out = [];
    for (const name of names) {
        const id = name.replace('.meta.json', '');
        const path = join(sessionDir, `${id}.jsonl`);
        const metaPath = join(sessionDir, name);
        // a half-written meta or a transcript deleted mid-poll skips this agent for this poll, not the whole list
        try {
            const st = await stat(path);
            if (now - st.mtimeMs > MAX_AGE_MS) {
                continue;
            }

            let hit = cache.get(path);
            if (!hit || hit.mtimeMs !== st.mtimeMs) {
                const meta = await readMeta(metaPath, hit?.meta);
                if (!meta) {
                    continue;
                }
                hit = { mtimeMs: st.mtimeMs, meta, entries: (meta.spawnDepth ?? 1) > 1 ? [] : await readTail(path, st.size, AGENT_TAIL_BYTES, AGENT_TAIL_BYTES) };
                cache.set(path, hit);
            }
            if ((hit.meta.spawnDepth ?? 1) > 1) {
                continue;
            }

            // meta.finished flips after the last transcript write, so re-read it while the agent isn't done
            if (!hit.meta.finished) {
                hit.meta = await readMeta(metaPath, hit.meta);
            }

            const a = summarizeAgent(hit.meta, hit.entries, now - st.mtimeMs, id);
            // transcript gitBranch is the parent checkout's branch, not the worktree's, so ask the worktree
            const head = a.status === 'done' ? null : await worktreeHead(hit.meta.worktreePath);
            out.push({ id, toolUseId: hit.meta.toolUseId ?? null, started: st.birthtimeMs, updated: st.mtimeMs, usage: await readUsage(path, st.size), prompt: await firstPrompt(path), branches: [head ?? a.branch, hit.meta.worktreeBranch].filter(Boolean), ...a });
        } catch {
            continue;
        }
    }

    const rank = { running: 0, stopped: 1, done: 2 };

    return out.sort((a, b) => rank[a.status] - rank[b.status] || b.updated - a.updated);
}

export function status(lastTurn, ageMs, turn = { state: ageMs < WORKING_MS ? 'working' : 'idle' }) {

    if (turn.state === 'working') {
        return 'working';
    }
    if (turn.state === 'asking' || (lastTurn?.type === 'assistant' && ageMs < WAITING_MS)) {
        return 'waiting';
    }

    return 'idle';
}

// Every PR/MR the session linked, with when it last did.
function prLinks(entries) {

    const at = new Map();
    for (const e of entries) {
        if (e.type === 'pr-link' && e.prUrl) {
            at.set(e.prUrl, Math.max(at.get(e.prUrl) ?? 0, Date.parse(e.timestamp) || 0));
        }
    }

    return [...at].map(([url, t]) => ({ url, at: t }));
}

// When the session last really did something: a human prompt (typed or queued) or Claude's text/tool call. File mtime
// isn't it, since an idle claude process keeps appending cost-state, bridge-session and similar bookkeeping lines.
export function lastActivity(entries) {

    const e = entries.findLast(e => !e.isSidechain && (isHumanPrompt(e)
        || (e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.origin?.kind === 'human')
        || (e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'text' || b.type === 'tool_use'))));
    const at = Date.parse(e?.timestamp);

    return Number.isNaN(at) ? null : at;
}

export function summarize(entries, ageMs) {

    const last = type => entries.findLast(e => e.type === type);
    const turns = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
    const meta = entries.findLast(e => e.cwd) ?? {};
    const lastTurn = turns.at(-1);
    const turn = turnState(entries, ageMs);
    const openPrompts = turnPrompts(entries, ageMs);

    return {
        id: meta.sessionId,
        cwd: meta.cwd,
        branch: meta.gitBranch,
        title: last('custom-title')?.customTitle ?? last('ai-title')?.aiTitle ?? null,
        pr: last('pr-link')?.prUrl ?? null,
        prs: prLinks(entries),
        model: entries.findLast(e => e.type === 'assistant')?.message?.model ?? null,
        status: status(lastTurn, ageMs, turn),
        asking: turn.state === 'asking',
        since: turn.since,
        topic: latestTopic(entries),
        openPrompts,
        now: openPrompts.at(-1)?.text ?? null, // the human prompt the running turn works on (newest absorbed one wins)
        queued: queuedPrompts(entries).map(q => q.text),
        lastPrompt: textOf(entries.findLast(isHumanPrompt)),
        lastReply: textOf(entries.findLast(e => e.type === 'assistant' && textOf(e) && !e.isSidechain)),
        sidechain: !!entries.find(e => e.type === 'user' || e.type === 'assistant')?.isSidechain, // a transcript a subagent wrote
        lastActivity: lastActivity(entries),
        files: filesTouched(entries, meta.cwd),
        gates: gateRuns(entries)
    };
}

// Session transcripts written within MAX_AGE_MS, as { dir, file, path, st }. A project folder or transcript that vanishes mid-listing is skipped.
async function* recentTranscripts(now) {

    for (const dir of await readdir(ROOT)) {
        let files;
        try {
            files = (await readdir(join(ROOT, dir))).filter(f => f.endsWith('.jsonl'));
        } catch {
            continue;
        }

        for (const file of files) {
            const path = join(ROOT, dir, file);
            let st;
            try {
                st = await stat(path);
            } catch {
                continue; // deleted between readdir and stat
            }
            if (now - st.mtimeMs > MAX_AGE_MS) {
                continue;
            }

            yield { dir, file, path, st };
        }
    }
}

// One session from its cached tail, with its subagents; null when the transcript vanished before it was read.
async function sessionOf({ dir, file, path, st }, now) {

    let entries;
    try {
        entries = await tailOf(path, st);
    } catch {
        return null; // deleted between stat and read
    }

    const s = summarize(entries, now - st.mtimeMs);
    const id = s.id ?? file.replace('.jsonl', '');

    const spawns = spawnPrompts(entries);
    const subagents = (await agents(join(ROOT, dir, id, 'subagents'), now)).map(a => ({ ...a, spawnedFor: spawns.get(a.toolUseId) ?? null }));

    return { ...s, id, dir, updated: st.mtimeMs, created: st.birthtimeMs, agents: subagents };
}

// The work items of all sessions (their PRs/MRs and agents), with PR/MR state, human comments and milestone.
async function itemsOf(out) {

    const urls = new Set(out.flatMap(s => [...s.prs.map(p => p.url), ...s.agents.flatMap(a => a.prs)]));
    const states = new Map(await Promise.all([...urls].map(async u => [u, await prState(u)])));
    // human comments on open MRs only; never waits, so the first poll after start has none yet
    const comments = new Map([...urls].filter(u => states.get(u)?.state === 'open')
        .map(u => [u, swrEntry(`comments:${u}`, PR_TTL_MS, () => fetchComments(u)).value ?? null]));

    const items = workItems(out, u => withThreads(states.get(u) ?? null, comments.get(u)));
    for (const it of items) {
        // only an already fetched milestone list; /api/milestones fills it for the projects on the board
        it.milestone = milestoneOf(it.prState, swr.get(`ms:${it.project}`)?.value ?? []);
        it.comments = comments.get(it.pr) ?? null;
    }

    return items;
}

// Each session gets its items and subagent counts; its raw agents, gates and open prompts stay out of the response.
function attachItems(out, items, now) {

    for (const s of out) {
        s.items = items.filter(i => i.sessionId === s.id);
        s.subagents = { running: s.agents.filter(a => a.status === 'running').length, finished: s.agents.filter(a => a.status === 'done' && now - a.updated < FINISHED_MS).length };
        s.items.forEach(i => { i.folder = folderFor(i.worktreePath, s.cwd); });
        delete s.agents; // folded into items
        delete s.gates;
        delete s.openPrompts;
    }
}

// Each session's tmux target. A /clear sent from Homebase starts a new transcript that keeps typing into the old tmux session.
function attachTmux(out, now) {

    for (const c of clears.splice(0)) {
        const next = findClearedSuccessor(out, c);
        if (next) {
            aliases.set(next.id, { tmux: c.tmux, from: c.from });
        } else if (now - c.clearedAt < CLEAR_WAIT_MS) {
            clears.push(c);
        }
    }

    for (const s of out) {
        const a = aliases.get(s.id);
        s.tmux = tmuxFor(s.id);
        if (a) {
            s.clearedFrom = a.from;
        }
    }
}

// By real activity, so an idle process's bookkeeping writes don't float it to the top.
const byActivity = (a, b) => (b.lastActivity ?? b.created) - (a.lastActivity ?? a.created);

export async function sessions() {

    const now = Date.now();
    const out = [];
    for await (const transcript of recentTranscripts(now)) {
        const s = await sessionOf(transcript, now);
        if (s) {
            out.push(s);
        }
    }

    await Promise.all(out.map(async s => {
        s.project = await projectOf(s.cwd);
    }));

    attachItems(out, await itemsOf(out), now);
    attachTmux(out, now);

    return out.sort(byActivity);
}

// Open in editor: the item's agent worktree if it's still there, else its session's cwd. Absolute paths only, so none reads as a flag.
export const folderFor = (worktreePath, cwd, exists = existsSync) => [worktreePath, cwd].find(p => p?.startsWith('/') && exists(p)) ?? null;
