// The session list: repo names, subagent summaries and status, session summaries, and sessions(), which joins them with
// PR/MR state, work items and /clear aliases for GET /api/sessions.
import { readdir, stat, open, readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, projectDirs, cache, liveSessions, readTail, tailOf, textOf, isHumanPrompt, EDIT_TOOLS, PR_URL, filesTouched, INTERRUPTED } from './entries.mjs';
import { WORKING_MS, closedSession, turnState, hasTurnMarkers, turnPrompts, helperAsk, askingHelper, openToolUse, pendingQuestion, askMarker, spawnPrompts } from './turns.mjs';
import { splitTldr, gateRuns, latestTopic, queuedPrompts } from './summaries.mjs';
import { readUsage, usageCache } from './usage.mjs';
import { chatItems } from './feed.mjs';
import { waitingQuestion } from './asks.mjs';
import { loadStore, record, seeds, flush, gateHeadsOf, STORE_FILE } from './store.mjs';
import { PR_TTL_MS, openMrUrls, prState, prError, problemText, forgeWords, forgeStatus, swrEntry, fetchComments, withThreads, swr } from './forge.mjs';
import { isManual } from './manual.mjs';
import { canned } from '../web/src/lib/canned.ts';
import { repoPaths, accountOf } from './account.mjs';
import { pushBlocked } from './gitpush.mjs';
import { contextOf } from './limits.mjs';
import { workItems, milestoneOf, sameRepo } from './items.mjs';
import { plainCommand } from '../web/src/lib/text.ts';
import { rulesStale, readSeen } from './rules.mjs';
import { checksStatus } from './checks.mjs';
import { aliases, clears, CLEAR_WAIT_MS, tmuxFor, findClearedSuccessor, linkClears, liveTmux, mapNewProjects, startingProjects } from './tmux.mjs';

const run = promisify(execFile);

const MAX_AGE_MS = Number(process.env.MAX_AGE_DAYS ?? 3) * 864e5;
const WAITS_AGE_MS = Math.max(MAX_AGE_MS, 14 * 864e5); // a chat that still waits on the user stays listed this long
const WAITING_MS = 30 * 60_000;
const FINISHED_MS = 2 * 3600_000; // a finished subagent counts as recent this long
const AGENT_TAIL_BYTES = 128 * 1024;
// Silence an unfinished subagent may keep before it counts as stopped, by what its transcript ends on.
const AGENT_TOOL_MS = 30 * 60_000; // a tool call is still pending (long Bash, own background subagent)
const AGENT_THINK_MS = 10 * 60_000; // last entry is a tool result, user message or thinking-only chunk, so the model is thinking
const AGENT_IDLE_MS = 2 * 60_000; // ended its turn with text but never handed back

const store = loadStore();
const gateHeads = gateHeadsOf(store);
const projects = new Map(); // cwd -> repo name
export { repoPaths }; // repo name -> { host, path }, from the origin URL

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

// A git failure or timeout gives the folder name for now but is not cached, so the next call asks git again.
export async function projectOf(cwd, exec = run) {

    if (!cwd) {
        return '—';
    }
    if (!projects.has(cwd)) {
        // repo name from origin (so a folder named differently still shows the real repo), else the main checkout's folder
        const opts = { timeout: 5000 };
        projects.set(cwd, exec('git', ['-C', cwd, 'remote', 'get-url', 'origin'], opts)
            .then(({ stdout }) => {
                const name = repoName(stdout);
                const repo = repoPath(stdout);
                if (repo) {
                    repoPaths.set(name, repo);
                }

                return name;
            })
            .catch(() => exec('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], opts)
                .then(({ stdout }) => basename(dirname(stdout.trim()))))
            .catch(() => {
                projects.delete(cwd);

                return basename(cwd.replace(/\/\.(claude\/)?worktrees\/.*$/, ''));
            }));
    }

    return projects.get(cwd);
}

// Commits ahead of the upstream per cwd, refreshed at most every UNPUSHED_TTL_MS; null with no upstream or on any git error.
const UNPUSHED_TTL_MS = 30_000;
const unpushed = new Map(); // cwd -> { at, n }
export async function unpushedOf(cwd, now = Date.now(), exec = run) {

    if (!cwd) {
        return null;
    }
    const hit = unpushed.get(cwd);
    if (hit && now - hit.at < UNPUSHED_TTL_MS) {
        return hit.n;
    }

    unpushed.set(cwd, { at: now, n: hit?.n ?? null }); // concurrent callers within the ttl reuse the old value
    const n = await exec('git', ['-C', cwd, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 3000 })
        .then(({ stdout }) => Number(stdout.trim()), () => null);
    unpushed.set(cwd, { at: now, n });

    return n;
}

export const forgetUnpushed = cwd => unpushed.delete(cwd);

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

// Bash run_in_background, a Bash moved there by its timeout or a message, Monitor, background Workflow, async Agent.
// At a line start, so a file or transcript the agent read or grepped that quotes one doesn't count.
const LAUNCHED = /^(?:Command[^\n]*?(?:in background with ID: |moved to the background \(ID: )|Monitor started \(task |Workflow launched in background\. Task ID: )(\w+)|^Async agent launched successfully[\s\S]*?agentId: (\w+)/m;
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
        // a Monitor's event notices carry no <status>; only the closing one (completed, failed, killed) ends the task
        if (/<status>/.test(told)) {
            open.delete(told.match(NOTIFIED)?.[1]);
        }
    }

    return open;
}

// Status from the transcript tail: pending tool calls and thinking may be silent for long; an API error stops it at once.
// meta.finished flips when the agent ends its turn, even while it waits on its own background work to resume it, and
// when it dies on an API error.
export function agentStatus(meta, entries, ageMs) {

    const turns = entries.filter(e => e.type === 'assistant' || e.type === 'user');
    const last = turns.at(-1);
    if (last?.isApiErrorMessage) {
        const limited = last.error === 'rate_limit' || /rate.?limit|hit your limit|usage limit/i.test(textOf(last));
        return { status: 'stopped', stopReason: limited ? 'rate-limit' : 'api-error' };
    }
    // the user cut off a running tool call: a real stop, Continue resumes it
    if (last?.type === 'user' && /^\[Request interrupted by user for tool use\]$/.test(textOf(last).trim())) {
        return { status: 'stopped', stopReason: 'interrupted' };
    }

    // the chat stopped it on purpose (TaskStop): finished, nothing to continue. A /clear or a crash leaves no such entry,
    // and a message sent to it afterwards adds turns after this one.
    if (last?.type === 'user' && INTERRUPTED.test(textOf(last).trim())) {
        return { status: 'done', stopReason: 'killed' };
    }
    // the hand-back call is the agent's last act and gets no result, so it would read as a pending call for half an hour;
    // a message sent to it afterwards resumes it, so only a hand-back with no assistant turn after it counts
    const handback = turns.findLastIndex(e => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use' && b.name === 'SubagentHandback'));
    if (handback >= 0 && !turns.slice(handback + 1).some(e => e.type === 'assistant')) {
        return { status: 'done' };
    }

    const waiting = backgroundTasks(entries).size > 0;
    // meta.finished never clears: a user turn (a message, a task notice) after the turn that ended with text resumed it
    const endedAt = turns.findLastIndex(e => e.type === 'assistant' && !!textOf(e) && !(Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use')));
    const resumed = endedAt >= 0 && turns.slice(endedAt + 1).some(e => e.type === 'user' && !(Array.isArray(e.message?.content) && e.message.content.every(b => b.type === 'tool_result')));
    if (meta.finished && !resumed) {
        return { status: waiting && ageMs < AGENT_TOOL_MS ? 'running' : 'done' };
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

    // own background work is no silence: it may run for hours, and its closing notice resumes the agent
    if (waiting) {
        return { status: 'running' };
    }

    // its last turn ended with text and no tool call (a resumed helper that answers without handing back): it finished
    const endedTurn = !pending.size && last?.type === 'assistant' && !!textOf(last);
    if (endedTurn) {
        return { status: ageMs < AGENT_IDLE_MS ? 'running' : 'done' };
    }
    const limit = pending.size ? AGENT_TOOL_MS : AGENT_THINK_MS;

    // a guess: nothing says it stopped, it has only been quiet for too long
    return ageMs < limit ? { status: 'running' } : { status: 'stopped', stopReason: 'silent' };
}

// A tool call as what the agent is doing, in plain words: "running npm test", "editing login.js".
const firstLine = (t, n = 60) => {
    const l = String(t ?? '').trim().split('\n')[0];
    return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};
export function stepOf(use) {

    const i = use.input ?? {}, file = basename(i.file_path ?? i.notebook_path ?? '');
    const say = {
        Bash: () => (i.description ? firstLine(i.description).replace(/^./, c => c.toLowerCase()) : plainCommand(i.command)),
        Edit: () => `editing ${file}`, MultiEdit: () => `editing ${file}`, Write: () => `writing ${file}`, NotebookEdit: () => `editing ${file}`,
        Read: () => `reading ${file}`, Grep: () => 'searching the code', Glob: () => 'searching the code',
        Agent: () => `waiting on a helper agent${i.description ? `: ${firstLine(i.description, 40)}` : ''}`, Task: () => 'waiting on a helper agent',
        WebFetch: () => 'reading a web page', WebSearch: () => 'searching the web', SubagentHandback: () => 'reporting back'
    }[use.name];

    return say ? say() : `using ${use.name}`;
}

// The helper's conclusion in a line: the first sentence, at most 120 characters.
export function outcomeOf(text) {

    const line = String(text ?? '').replace(/^#+\s*|\*\*|`/gm, '').trim().split('\n').find(l => l.trim())?.trim() ?? '';
    const first = line.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? line;

    return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

export function summarizeAgent(meta, entries, ageMs, id) {

    const uses = entries.flatMap(e => (e.type === 'assistant' && Array.isArray(e.message?.content) ? e.message.content : []))
        .filter(b => b.type === 'tool_use');
    const handback = uses.findLast(b => b.name === 'SubagentHandback')?.input?.message;
    const report = handback ?? textOf(entries.findLast(e => e.type === 'assistant' && textOf(e))) ?? '';
    const { status, stopReason } = agentStatus(meta, entries, ageMs);
    const { tldr, text: body } = splitTldr(report);
    const outcome = status === 'done' ? outcomeOf(tldr || body) : null;
    const stage = Math.max(agentStage(uses, report, status === 'done'), stagePeak.get(id) ?? 0);
    const lastCall = entries.findLast(e => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use'));
    if (id) {
        stagePeak.set(id, stage);
    }

    return {
        description: meta.description ?? meta.agentType,
        status,
        stopReason,
        outcome,
        stage,
        stageLabel: STAGES[stage],
        step: uses.length ? stepOf(uses.at(-1)) : null, // the newest tool call, as what it is doing now
        stepAt: Date.parse(lastCall?.timestamp) || null,
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
            out.push({ id, toolUseId: hit.meta.toolUseId ?? null, started: st.birthtimeMs, updated: st.mtimeMs, openTool: a.status === 'running' && openToolUse(hit.entries), usage: await readUsage(path, st.size), prompt: await firstPrompt(path), branches: [head ?? a.branch, hit.meta.worktreeBranch].filter(Boolean), ...a });
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

    const at = new Map(); // url -> { at, repo }, repo being the entry's own prRepository (owner/name)
    for (const e of entries) {
        if (e.type === 'pr-link' && e.prUrl) {
            const old = at.get(e.prUrl);
            at.set(e.prUrl, { at: Math.max(old?.at ?? 0, Date.parse(e.timestamp) || 0), repo: e.prRepository ?? old?.repo });
        }
    }

    return [...at].map(([url, v]) => ({ url, ...v }));
}

// When the session last really did something: a human prompt (typed or queued), a slash command (a /model pick: the user
// is there, so auto-compact waits) or Claude's text/tool call. File mtime isn't it, since an idle claude process keeps
// appending cost-state, bridge-session and similar bookkeeping lines.
export function lastActivity(entries) {

    const e = entries.findLast(e => !e.isSidechain && (isHumanPrompt(e)
        || (e.type === 'user' && textOf(e).startsWith('<command-name>'))
        || (e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.origin?.kind === 'human')
        || (e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'text' || b.type === 'tool_use'))));
    const at = Date.parse(e?.timestamp);

    return Number.isNaN(at) ? null : at;
}

// What the running turn does now: its newest tool call in words ("running npm test"), or null before its first one.
function turnStep(turns, since) {

    const e = turns.findLast(e => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use'));
    if (!e || (since && Date.parse(e.timestamp) < since)) {
        return null;
    }

    return { step: stepOf(e.message.content.findLast(b => b.type === 'tool_use')), at: Date.parse(e.timestamp) || null };
}

export function summarize(entries, ageMs, marker = null, live = null) {

    const last = type => entries.findLast(e => e.type === type);
    const turns = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
    const meta = entries.findLast(e => e.cwd) ?? {};
    const lastTurn = turns.at(-1);
    const turn = turnState(entries, ageMs, marker, live);
    const openPrompts = turnPrompts(entries, ageMs, marker, live);
    const lastItem = chatItems(entries, 1).at(-1); // the chat's newest bubble, so the Work tab and the chat agree on "needs you"

    const step = turn.state === 'working' ? turnStep(turns, turn.since) : null;
    const needsYou = turn.state === 'idle' && lastItem?.role === 'assistant' && !!lastItem.needsYou && !lastItem.answer && !lastItem.error;

    return {
        id: meta.sessionId,
        cwd: meta.cwd,
        branch: meta.gitBranch,
        title: last('custom-title')?.customTitle ?? last('ai-title')?.aiTitle ?? null,
        pr: last('pr-link')?.prUrl ?? null,
        prs: prLinks(entries),
        model: entries.findLast(e => e.type === 'assistant')?.message?.model ?? null,
        status: status(lastTurn, ageMs, turn),
        known: hasTurnMarkers(entries), // false: no turn markers in a recent transcript, so the status is only a guess
        asking: turn.state === 'asking',
        died: !!turn.died, // its turn never ended and nothing works on it: the board keeps a row until the user has looked
        question: turn.state === 'asking' ? pendingQuestion(entries, marker) : null,
        needsYou,
        needsId: needsYou ? lastItem?.id ?? null : null, // that reply's id, to mark it as handled (POST /api/handled)
        needsText: needsYou ? firstLine(lastItem?.ask?.question ?? waitingQuestion(lastItem?.waiting) ?? lastItem?.tldr, 140) || null : null, // what it asks, for the Needs you row's title
        since: turn.since,
        topic: latestTopic(entries),
        openPrompts,
        now: openPrompts.at(-1)?.text ?? null, // the human prompt the running turn works on (newest absorbed one wins)
        step: step?.step ?? null,
        stepAt: step?.at ?? null, // when that call started, for "for 2m" on the Now line
        queued: queuedPrompts(entries).map(q => q.text),
        lastPrompt: textOf(entries.findLast(isHumanPrompt)),
        lastReply: textOf(entries.findLast(e => e.type === 'assistant' && textOf(e) && !e.isSidechain)),
        sidechain: !!entries.find(e => e.type === 'user' || e.type === 'assistant')?.isSidechain, // a transcript a subagent wrote
        lastActivity: lastActivity(entries),
        files: filesTouched(entries, meta.cwd),
        gates: gateRuns(entries)
    };
}

// Session transcripts written within MAX_AGE_MS, plus older ones (old: true) up to WAITS_AGE_MS not known as settled, as { dir, file, path, st, old }. A project folder or transcript that vanishes mid-listing is skipped.
async function* recentTranscripts(now) {

    for (const dir of await projectDirs()) {
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
            const old = now - st.mtimeMs > MAX_AGE_MS;
            if (now - st.mtimeMs > WAITS_AGE_MS || (old && settled.get(path) === st.mtimeMs)) {
                continue;
            }

            yield { dir, file, path, st, old };
        }
    }
}

// An old transcript (past MAX_AGE_MS) is listed only while its chat still waits on the user. One that doesn't is noted
// in `settled` and not read again until it changes; one that does is `held`, so its cached tail stays.
const settled = new Map(); // path -> the mtime it was found settled at
const held = new Set();
function keepOld({ path, st }, s) {

    if (s.needsYou || s.asking) {
        held.add(path);
        return true;
    }
    settled.set(path, st.mtimeMs);
    cache.delete(path);

    return false;
}

// The newest SendMessage summary per agent id: an agent the master continued for other work goes by that.
// ponytail: only the parsed tail; an older SendMessage is missed and the row keeps its spawn description
export function sentSummaries(entries) {

    const out = new Map();
    for (const e of entries) {
        const blocks = e.type === 'assistant' && !e.isSidechain && Array.isArray(e.message?.content) ? e.message.content : [];
        for (const b of blocks) {
            if (b.type === 'tool_use' && b.name === 'SendMessage' && b.input?.to && b.input.summary) {
                out.set(b.input.to, b.input.summary);
            }
        }
    }

    return out;
}

// read(transcript, ...), but a transcript it throws on gives null, so one unreadable chat never fails the whole list.
// Logged once per file and size, not on every poll.
export function tolerant(read, log = console.error) {

    const logged = new Map(); // path -> the size it was logged at

    return async (t, ...rest) => {
        try {
            return await read(t, ...rest);
        } catch (e) {
            if (logged.get(t.path) !== t.st.size) {
                logged.set(t.path, t.st.size);
                log(`skipped a transcript Homebase can't read: ${t.path}: ${e.message}`);
            }

            return null;
        }
    };
}

// When "died" rows start: noted in the Homebase dir the first time a server with them runs, so the turns that died
// before (every chat of the last days that ended mid-turn) never show up at once. An unreadable note starts over.
// Written like items.json (temp file + rename, 0600); if that fails, this process still keeps its own start.
let diedFrom;
export function diedSince(file = join(dirname(STORE_FILE), 'died-since.json'), now = Date.now()) {

    try {
        const at = JSON.parse(readFileSync(file, 'utf8'));
        if (Number.isFinite(at)) {
            return at;
        }
    } catch {}
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(now), { mode: 0o600 });
        renameSync(`${file}.${process.pid}.tmp`, file);
    } catch (e) {
        console.error(`could not write ${file}: ${e.message}`);
    }

    return now;
}

// One session from its cached tail, with its subagents; null when the transcript vanished before it was read.
const sessionOf = tolerant(readSession);
async function readSession({ dir, file, path, st }, now, live) {

    let entries;
    try {
        entries = await tailOf(path, st);
    } catch {
        return null; // deleted between stat and read
    }

    const marker = await askMarker(file.replace('.jsonl', ''), { live });
    const s = summarize(entries, now - st.mtimeMs, marker, live);
    const id = s.id ?? file.replace('.jsonl', '');

    // subagents run inside their session's process, so they end with it
    const closed = closedSession(entries, now - st.mtimeMs, live);
    const spawns = spawnPrompts(entries);
    const renamed = sentSummaries(entries);
    const subagents = (await agents(join(ROOT, dir, id, 'subagents'), now))
        .map(a => ({
            ...a,
            ...(renamed.get(a.id) && renamed.get(a.id) !== a.description && { description: renamed.get(a.id), firstDescription: a.description }),
            spawnedFor: spawns.get(a.toolUseId) ?? null,
            ...(closed && a.status === 'running' && { status: 'stopped', stopReason: 'closed' })
        }));

    // a permission prompt no tool of the chat's own waits on is a helper's: the row of the one helper that waits on a tool is the one asking
    if (s.asking && helperAsk(marker, entries, now)) {
        s.helperAsking = true;
        s.askingAgent = askingHelper(subagents);
    }

    const ctx = await contextOf(id);

    diedFrom ??= diedSince();
    s.died &&= (s.lastActivity ?? st.mtimeMs) > diedFrom; // only turns that died since the feature first ran here

    return { ...s, id, dir, updated: st.mtimeMs, created: st.birthtimeMs, context: ctx?.percent ?? null, contextSize: ctx?.size ?? null, contextAt: ctx?.at ?? null, checks: checksStatus(id), agents: subagents };
}

// The work items of all sessions (their PRs/MRs and agents), with PR/MR state, human comments and milestone.
async function itemsOf(out) {

    // the user's open MRs from the forge, for projects with sessions: found even when no transcript names them
    const forge = [...new Set(out.map(s => s.project))].filter(p => repoPaths.has(p))
        .flatMap(project => openMrUrls(project, repoPaths.get(project)).map(url => ({ url, project })));
    // MRs stored earlier, so a pr-link that scrolled out of a tail doesn't drop the item
    const seeded = [...forge, ...seeds(store, Date.now(), MAX_AGE_MS)];
    const urls = new Set([...out.flatMap(s => [...s.prs.filter(p => sameRepo(p.url, s.project, p.repo)).map(p => p.url), ...s.agents.flatMap(a => a.prs)]), ...seeded.map(f => f.url)]);
    const states = new Map(await Promise.all([...urls].map(async u => [u, await prState(u)])));
    // human comments on open MRs only; never waits, so the first poll after start has none yet
    const comments = new Map([...urls].filter(u => states.get(u)?.state === 'open')
        .map(u => [u, swrEntry(`comments:${u}`, PR_TTL_MS, () => fetchComments(u)).value ?? null]));

    // a failed lookup: the MR state's error, else the comments' (the `unknown` row kind says it in its text)
    const errorOf = (url, project) => {
        const commentsError = problemText(swr.get(`comments:${url}`)?.error, forgeWords(project, url).cli);
        return prError(url) ?? (commentsError && `comments: ${commentsError}`);
    };
    const items = workItems(out, u => withThreads(states.get(u) ?? null, comments.get(u)), Date.now(), gateHeads, seeded, undefined, errorOf);
    for (const it of items) {
        // only an already fetched milestone list; /api/milestones fills it for the projects on the board
        it.milestone = milestoneOf(it.prState, swr.get(`ms:${it.project}`)?.value ?? []);
        it.comments = comments.get(it.pr) ?? null;
        // a failed lookup: without any state the row says why; with an older one it is flagged stale
        it.forgeError = it.pr ? errorOf(it.pr, it.project) : null;
    }
    // each project's forge state, on its sessions: the page says once when the forge can't be reached, and how old its data is
    for (const project of new Set(out.map(s => s.project))) {
        const status = forgeStatus(project, items.filter(i => i.project === project && i.pr).map(i => i.pr));
        out.filter(s => s.project === project).forEach(s => { s.forge = status; });
    }
    record(store, items);
    flush(store);
    items.forEach(i => { delete i.agentLinks; delete i.gateHead; });

    return items;
}

// An item of a /clear-ed chat moves to its successor (clearedFrom, followed to the end), so its button types into the live chat
// (a send to the cleared one is refused, as its tmux now runs the successor).
export function followClears(items, sessions) {

    const next = new Map(sessions.filter(s => s.clearedFrom).map(s => [s.clearedFrom, s.id]));
    for (const i of items) {
        for (let hops = 0; next.has(i.sessionId) && hops < 50; hops++) {
            i.sessionId = next.get(i.sessionId);
        }
    }
}

// Each session gets its items and subagent counts; its raw agents, gates and open prompts stay out of the response.
function attachItems(out, items, now) {

    followClears(items, out);
    for (const s of out) {
        s.items = items.filter(i => i.sessionId === s.id);
        s.subagents = { running: s.agents.filter(a => a.status === 'running').length, finished: s.agents.filter(a => a.status === 'done' && now - a.updated < FINISHED_MS).length };
        delete s.agents; // folded into items
        delete s.gates;
        delete s.openPrompts;
    }
}

// Each session's tmux target. A /clear sent from Homebase starts a new transcript that keeps typing into the old tmux session.
async function attachTmux(out, now, live) {

    for (const c of clears.splice(0)) {
        const next = findClearedSuccessor(out, c);
        if (next) {
            aliases.set(next.id, { tmux: c.tmux, from: c.from });
        } else if (now - c.clearedAt < CLEAR_WAIT_MS) {
            clears.push(c);
        }
    }

    const tmuxList = await liveTmux();
    mapNewProjects(out, tmuxList);

    for (const s of out) {
        s.tmux = tmuxFor(s.id, aliases, live); // the registry knows a /clear successor's tmux after a restart emptied the aliases
    }
    linkClears(out, live);

    const seen = await readSeen();
    await Promise.all(out.map(async s => {
        const started = live?.started.get(s.id) ?? tmuxList.find(t => t.name === s.tmux)?.created;
        const stale = await rulesStale(started, s.cwd, now, undefined, seen[s.id]);
        if (stale && !(seen[s.id] >= stale.at)) {
            s.rulesStale = stale.names;
            s.rulesAt = stale.at;
            s.rulesReload = stale.reload;
        }
    }));
}

// By real activity, so an idle process's bookkeeping writes don't float it to the top.
const byActivity = (a, b) => (b.lastActivity ?? b.created) - (a.lastActivity ?? a.created);

// Transcripts that aged out of the listing leave every per-transcript cache, so a long-running server doesn't grow.
function forgetAged(now) {

    for (const [path, hit] of cache) {
        if (now - hit.mtimeMs > MAX_AGE_MS && !held.has(path)) {
            cache.delete(path);
            prompts.delete(path);
            usageCache.delete(path);
            stagePeak.delete(basename(path, '.jsonl'));
        }
    }
    held.clear(); // refilled by this listing
    for (const [path, mtimeMs] of settled) {
        if (now - mtimeMs > WAITS_AGE_MS) {
            settled.delete(path);
        }
    }
}

// Chats of new projects that have a tmux session but no transcript yet.
export async function startingChats() {

    return startingProjects(await sessions(), await liveTmux());
}

export async function sessions() {

    const now = Date.now();
    forgetAged(now);
    const live = await liveSessions();
    const out = [];
    for await (const transcript of recentTranscripts(now)) {
        const s = await sessionOf(transcript, now, live);
        if (s && (!transcript.old || keepOld(transcript, s))) {
            out.push(s);
        }
    }

    await Promise.all(out.map(async s => {
        s.project = await projectOf(s.cwd);
        const repo = repoPaths.get(s.project);
        s.hobby = !!repo && accountOf(repo) === 'personal';
        s.unpushed = await unpushedOf(s.cwd);
        s.pushBlocked = s.unpushed > 0 && await pushBlocked(s);
    }));

    await attachTmux(out, now, live); // first: it sets clearedFrom, which attachItems follows
    attachItems(out, await itemsOf(out), now);
    for (const s of out) {
        s.manual = isManual(s.id);
        s.items?.forEach(it => { it.manual = isManual(it.sessionId);
            it.action ??= it.manual && it.sessionId ? canned('plan') : null;
        });
    }

    return out.sort(byActivity);
}

// One build shared by the callers that arrive while it runs, its result reused for ttlMs: a failed build is not kept.
export function shared(build, ttlMs = 1000, now = Date.now) {

    let flight = null, at = -Infinity, last, gen = 0;

    const get = () => {
        if (now() - at < ttlMs) {
            return Promise.resolve(last);
        }
        if (!flight) {
            const mine = gen;
            flight = build().then(value => {
                if (mine === gen) { // not begun before a stale(): its list may miss the write
                    last = value;
                    at = now();
                }

                return value;
            }).finally(() => {
                if (mine === gen) {
                    flight = null;
                }
            });
        }

        return flight;
    };
    // after a write the list reflects (a dismiss): the next call builds afresh, not from the cache or a build begun before
    get.stale = () => {
        gen++;
        at = -Infinity;
        flight = null;
    };

    return get;
}

// sessions() for the polls (every open page asks every 1.5s, the push watcher every 5s): at most one build at a time, about one a second.
// ponytail: the actions (send, new project) still build their own fresh list
export const polledSessions = shared(sessions);
