// Dashboard over Claude Code transcripts in ~/.claude/projects. Never writes files; only types into its own tmux sessions.
import { createServer } from 'node:http';
import { readdir, stat, open, readFile, access, realpath } from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, extname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
// HOMEBASE_TMUX_SOCKET points every tmux call at a separate server (tmux -L), so tests never touch real sessions.
export const tmuxArgs = (args, socket = process.env.HOMEBASE_TMUX_SOCKET) => (socket ? ['-L', socket, ...args] : args);
const tmux = args => run('tmux', tmuxArgs(args));

const ROOT = join(homedir(), '.claude', 'projects');
const PORT = Number(process.env.PORT ?? 4321);
const MAX_AGE_MS = Number(process.env.MAX_AGE_DAYS ?? 3) * 864e5;
// ponytail: only the tail is parsed (transcripts reach 70+ MB); subagent token totals use the offset reader below
const TAIL_BYTES = 512 * 1024;
const WORKING_MS = 10_000;
const WAITING_MS = 30 * 60_000;

const PR_TTL_MS = 60_000;
const AGENT_TAIL_BYTES = 128 * 1024;
// Silence an unfinished subagent may keep before it counts as stopped, by what its transcript ends on.
const AGENT_TOOL_MS = 30 * 60_000; // a tool call is still pending (long Bash, own background subagent)
const AGENT_THINK_MS = 10 * 60_000; // last entry is a tool result or user message, so the model is thinking
const AGENT_IDLE_MS = 2 * 60_000; // ended its turn with text but never handed back

const cache = new Map(); // path -> { mtimeMs, entries }
const projects = new Map(); // cwd -> repo name
const prs = new Map(); // url -> { at, value, pending }
const repoPaths = new Map(); // repo name -> { host, path }, from the origin URL

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

async function projectOf(cwd) {

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

// CI pipeline as { status, url, at } or null. GitLab passes the MR's head_pipeline (or legacy pipeline) as-is;
// GitHub's statusCheckRollup is rolled up to success, failed or running (CheckRuns and StatusContexts alike).
export function pipelineOf(gl, checks, prUrl) {

    if (gl) {
        return { status: gl.status, url: gl.web_url ?? null, at: gl.finished_at ?? gl.updated_at ?? null };
    }
    if (!checks?.length) {
        return null;
    }

    const outcome = c => c.conclusion || (c.status && c.status !== 'COMPLETED' ? 'PENDING' : c.state);
    const all = checks.map(outcome);
    const status = all.some(o => ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED'].includes(o)) ? 'failed'
        : all.some(o => ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(o) || !o) ? 'running'
            : 'success';
    const at = checks.map(c => c.completedAt ?? c.startedAt).filter(Boolean).sort().at(-1) ?? null;

    return { status, url: `${prUrl}/checks`, at };
}

// The coarse ci flag nextStep/rowAction read: 'failing', 'running' or null.
export const ciOf = pipeline => ({ failed: 'failing', running: 'running', pending: 'running' })[pipeline?.status] ?? null;

// Read-only PR/MR lookup via gh/glab. Returns { state: open|merged|closed, title, branch, reviewers, ready, changes, changesBy, draft, ci, pipeline } or null.
async function fetchPr(url) {

    const gl = url.match(/^https:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)/);
    if (gl) {
        const { stdout } = await run('glab', ['api', `projects/${encodeURIComponent(gl[1])}/merge_requests/${gl[2]}`]);
        const mr = JSON.parse(stdout);
        const state = { opened: 'open', merged: 'merged' }[mr.state] ?? 'closed';
        const status = mr.detailed_merge_status;
        const pipeline = pipelineOf(mr.head_pipeline ?? mr.pipeline);

        return {
            state,
            title: mr.title,
            branch: mr.source_branch,
            reviewers: (mr.reviewers ?? []).map(r => r.name),
            ready: status === 'mergeable',
            // ponytail: the MR payload doesn't say which reviewer blocked; the /reviewers endpoint would
            changes: status === 'requested_changes' || status === 'discussions_not_resolved',
            changesBy: [],
            draft: !!mr.draft,
            ci: { ci_must_pass: 'failing', ci_still_running: 'running' }[status] ?? ciOf(pipeline),
            pipeline,
            milestone: mr.milestone ? { id: mr.milestone.id, title: mr.milestone.title, due_date: mr.milestone.due_date } : null,
            target: mr.target_branch
        };
    }

    const { stdout } = await run('gh', ['pr', 'view', url, '--json', 'state,title,reviewDecision,isDraft,headRefName,baseRefName,milestone,reviewRequests,latestReviews,statusCheckRollup']);
    const pr = JSON.parse(stdout);
    const pipeline = pipelineOf(null, pr.statusCheckRollup, url);
    const reviews = pr.latestReviews ?? [];

    return {
        state: pr.state.toLowerCase(),
        title: pr.title,
        branch: pr.headRefName,
        reviewers: [...new Set([...(pr.reviewRequests ?? []).map(r => r.login ?? r.name), ...reviews.map(r => r.author?.login)].filter(Boolean))],
        ready: pr.reviewDecision === 'APPROVED' && !pr.isDraft,
        changes: pr.reviewDecision === 'CHANGES_REQUESTED',
        changesBy: reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author?.login).filter(Boolean),
        draft: pr.isDraft,
        ci: ciOf(pipeline),
        pipeline,
        milestone: pr.milestone ? { id: pr.milestone.number, title: pr.milestone.title, due_date: pr.milestone.dueOn?.slice(0, 10) ?? null } : null,
        target: pr.baseRefName
    };
}

// Stale-while-revalidate so a slow CLI call never blocks the board after the first load.
async function prState(url) {

    if (!url) {
        return null;
    }

    let hit = prs.get(url);
    if (!hit) {
        hit = { at: 0, value: null };
        prs.set(url, hit);
    }
    if (Date.now() - hit.at > PR_TTL_MS && !hit.pending) {
        hit.pending = fetchPr(url)
            .then(v => { hit.value = v; })
            .catch(() => {})
            .finally(() => { hit.at = Date.now(); hit.pending = null; });
    }
    if (!hit.at) {
        await hit.pending;
    }

    return hit.value;
}

export function column(status, pr, hasPr) {

    if (status === 'working') {
        return 'doing';
    }
    if (pr?.state === 'merged' || pr?.state === 'closed') {
        return 'done';
    }
    if (pr?.changes) {
        return 'needs-you';
    }
    if (pr?.ready) {
        return 'ready';
    }
    if (hasPr) {
        return 'review';
    }

    return status === 'waiting' ? 'needs-you' : 'idle';
}

async function readTail(path, size, max = TAIL_BYTES) {

    const fh = await open(path, 'r');
    try {
        const len = Math.min(size, max);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < size) {
            lines.shift(); // partial first line
        }

        return lines.flatMap(l => {
            try {
                return l ? [JSON.parse(l)] : [];
            } catch {
                return [];
            }
        });
    } finally {
        await fh.close();
    }
}

async function tailOf(path, st) {

    let hit = cache.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
        hit = { mtimeMs: st.mtimeMs, entries: await readTail(path, st.size) };
        cache.set(path, hit);
    }

    return hit.entries;
}

function textOf(entry) {

    const c = entry?.message?.content;
    if (typeof c === 'string') {
        return c;
    }

    return Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
}

function isHumanPrompt(e) {
    return e.type === 'user' && !e.isMeta && !e.isSidechain && textOf(e) && !textOf(e).startsWith('<');
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Files Claude edited, newest first, from tool calls in the parsed tail.
export function filesTouched(entries, cwd) {

    const paths = entries
        .filter(e => e.type === 'assistant' && Array.isArray(e.message?.content))
        .flatMap(e => e.message.content)
        .filter(b => b.type === 'tool_use' && EDIT_TOOLS.has(b.name))
        .map(b => b.input?.file_path ?? b.input?.notebook_path)
        .filter(Boolean)
        .map(f => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f));

    return [...new Set(paths.reverse())].slice(0, 20);
}

const PR_URL = /https:\/\/[^\s)>\]`'"]+?\/(?:-\/merge_requests|pull)\/\d+/g;
const TLDR = /^[ \t>*_]*TL;?DR\b[*_]*:?[*_]*[ \t]*(.+)$/gim;

// Pulls the last "TLDR: ..." line out of a message so the page can show it as a callout.
export function splitTldr(text) {

    const m = [...text.matchAll(TLDR)].at(-1);
    if (!m) {
        return { tldr: null, text };
    }

    let tldr = m[1].trim();
    if ((tldr.match(/\*\*/g)?.length ?? 0) % 2) {
        tldr = tldr.replace(/\*\*$/, '').trim(); // "**TLDR: x**" leaves a dangling **
    }

    return { tldr, text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

const TOOL_KIND = { Bash: 'cmd', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'search', Glob: 'search', Agent: 'agent', Task: 'agent', WebFetch: 'web', WebSearch: 'web' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const PHRASES = {
    cmd: n => `ran ${plural(n, 'command')}`,
    edit: n => `edited ${plural(n, 'file')}`,
    read: n => `read ${plural(n, 'file')}`,
    search: n => `searched ${plural(n, 'time')}`,
    agent: n => `started ${plural(n, 'agent')}`,
    web: n => plural(n, 'web lookup'),
    other: n => `used ${plural(n, 'other tool')}`
};

// "Ran 3 commands · edited 2 files · started 2 agents"
export function toolSummary(uses) {

    const counts = {};
    const edited = new Set();
    for (const u of uses) {
        const kind = TOOL_KIND[u.name] ?? 'other';
        if (kind === 'edit') {
            edited.add(u.input?.file_path ?? u.input?.notebook_path);
        } else {
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    }
    counts.edit = edited.size;

    const text = Object.keys(PHRASES).filter(k => counts[k]).map(k => PHRASES[k](counts[k])).join(' · ');

    return text.charAt(0).toUpperCase() + text.slice(1);
}

// Multi-line pastes are stored as `<pasted_content id="x">…</pasted_content id="x">`; show only what was typed.
const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;
export const unwrapPasted = s => (typeof s === 'string' ? s.replace(PASTED, '$2').trim() : '');
const DUP_MS = 60_000;
const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/;

// Master chat as bubbles: human prompts, Claude's text (consecutive chunks merged), and one activity line per run of tool calls.
export function chatItems(entries, max = 60) {

    const items = [];
    let uses = [];
    const flush = () => {
        if (uses.length) {
            items.push({ role: 'tools', text: toolSummary(uses) });
            uses = [];
        }
    };

    // ponytail: replays the queue in the tail; a dequeue whose enqueue fell out of the tail shifts the wrong item
    const queue = [];
    // A non-tool-result user entry (agent message, task notification, reminder) starts a new turn, so the next reply gets its own bubble.
    let newTurn = false;

    for (const e of entries) {
        if (e.isSidechain) {
            continue;
        }
        const human = e.type === 'user' && !e.isMeta ? unwrapPasted(textOf(e)) : '';
        // "Send now" (Escape) leaves this marker; it flags Claude's message instead of showing as a bubble
        if (INTERRUPTED.test(human)) {
            const prev = items.findLast(i => i.role === 'assistant');
            if (prev) {
                prev.interrupted = true;
            }
            continue;
        }
        if (human && !human.startsWith('<')) {
            flush();
            items.push({ role: 'user', text: human, at: e.timestamp });
            continue;
        }
        // Messages typed while Claude works: queued first, then absorbed into the running turn as an attachment.
        if (e.type === 'queue-operation') {
            if (e.operation === 'enqueue') {
                queue.push({ raw: e.content, text: unwrapPasted(e.content), at: e.timestamp });
            } else if (e.operation === 'dequeue') {
                queue.shift();
            } else if (e.operation === 'remove') {
                const i = queue.findIndex(q => q.raw === e.content);
                if (i >= 0) {
                    queue.splice(i, 1);
                }
            }
            continue;
        }
        const a = e.type === 'attachment' ? e.attachment : null;
        if (a?.type === 'queued_command' && a.origin?.kind === 'human') {
            flush();
            items.push({ role: 'user', text: unwrapPasted(typeof a.prompt === 'string' ? a.prompt : textOf({ message: { content: a.prompt } })), at: e.timestamp });
            continue;
        }
        if (e.type === 'user' && !(Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_result'))) {
            newTurn = true;
        }
        if (e.type !== 'assistant') {
            continue;
        }

        const text = textOf(e);
        if (text) {
            flush();
            const prev = items.at(-1);
            if (prev?.role === 'assistant' && !newTurn) {
                prev.text += '\n\n' + text;
            } else {
                items.push({ role: 'assistant', text, at: e.timestamp });
            }
            newTurn = false;
        }
        if (Array.isArray(e.message?.content)) {
            uses.push(...e.message.content.filter(b => b.type === 'tool_use'));
        }
    }
    flush();

    for (const q of queue) {
        if (q.text && !q.text.startsWith('<')) {
            items.push({ role: 'user', text: q.text, at: q.at, pending: true });
        }
    }

    // One message can surface as a prompt, a queued_command attachment and a pending enqueue; keep the first.
    const seen = [];
    const unique = items.filter(i => {
        if (i.role !== 'user') {
            return true;
        }
        const norm = i.text.replace(/\s+/g, ' '), t = Date.parse(i.at);
        if (seen.some(u => u.norm === norm && Math.abs(u.t - t) < DUP_MS)) {
            return false;
        }
        seen.push({ norm, t });

        return true;
    });

    const out = pairAnswers(unique.map(i => (i.role === 'assistant' ? { ...i, ...splitTldr(i.text) } : i))).slice(-max);
    const last = out.at(-1);
    if (last?.role === 'assistant' && !last.answer) {
        last.replies = quickReplies(last.tldr, last.text); // only the newest item, so any later user message hides them
    }

    return out;
}

const SHORT_ANSWER = /^(?:yes|yeah|yep|sure|ok|okay|no|nope|do it|go ahead|do both)(?: please)?[.!]*$/i;

// A short reply right after a Claude message that asked something becomes its answer tag instead of a bubble:
// a chip label offered on it, or a tiny approval like "ok" / "go ahead". Only the item directly before counts.
export function pairAnswers(items) {

    const out = [];
    for (const i of items) {
        const prev = out.at(-1);
        const text = i.role === 'user' ? i.text.trim() : '';
        const asked = prev?.role === 'assistant' && !prev.answer && quickReplies(prev.tldr, prev.text);
        if (asked?.length && (asked.includes(text) || SHORT_ANSWER.test(text))) {
            out[out.length - 1] = { ...prev, answer: { text, at: i.at, ...(i.pending && { queued: true }) } };
            continue;
        }
        out.push(i);
    }

    return out;
}

const NOT_AN_OPTION = /\bor (?:not|no|so|something|anything|otherwise|later)\b/i;

// Reply chips for a Claude message that ends by asking the user something: its TLDR or its last paragraph ends in "?".
// Only the ending counts, so rhetorical or quoted questions earlier in the body don't; quotes, code and lists of questions are skipped.
export function quickReplies(tldr, text) {

    const lastParagraph = (text ?? '').trim().split(/\n\s*\n/).at(-1) ?? '';
    const ask = [tldr ?? '', lastParagraph]
        .map(s => s.trim().replace(/[*_\s]+$/, ''))
        .find(s => s.endsWith('?') && !/^(>|```|\|)/.test(s) && s.split('\n').filter(l => /\?[*_\s]*$/.test(l)).length === 1);
    if (!ask) {
        return [];
    }

    const question = ask.match(/[^.!?\n]*\?$/)[0];
    const twoOptions = /\bor\b/i.test(question) && !NOT_AN_OPTION.test(question);

    return twoOptions ? ['Yes', 'Do both', 'No'] : ['Yes', 'No'];
}

// The questions of an AskUserQuestion that has no tool_result yet, as [{ question, options: [label] }], else null.
export function pendingAsk(entries) {

    const ask = entries
        .filter(e => e.type === 'assistant' && !e.isSidechain && Array.isArray(e.message?.content))
        .flatMap(e => e.message.content)
        .findLast(b => b.type === 'tool_use' && b.name === 'AskUserQuestion');
    if (!ask) {
        return null;
    }

    const answered = entries.some(e => e.type === 'user' && Array.isArray(e.message?.content)
        && e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === ask.id));

    return answered ? null : (ask.input?.questions ?? []).map(q => ({ question: q.question ?? '', options: (q.options ?? []).map(o => o.label).filter(Boolean) }));
}

// The question text of a pending AskUserQuestion, else null.
export function pendingQuestion(entries) {

    const questions = pendingAsk(entries);

    return questions && (questions[0]?.question || 'Claude asked a question.');
}

// Background subagents a master session started (depth 1 only; their own helpers are noise).
export const STAGES = ['Explore', 'Implement', 'Verify', 'Ship', 'Done'];
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

// Status from the transcript tail: pending tool calls and thinking may be silent for long; an API error stops it at once.
export function agentStatus(meta, entries, ageMs) {

    if (meta.finished) {
        return { status: 'done' };
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

    const limit = pending.size ? AGENT_TOOL_MS : last?.type === 'assistant' ? AGENT_IDLE_MS : AGENT_THINK_MS;

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
        files: filesTouched(entries, meta.worktreePath ?? entries.findLast(e => e.cwd)?.cwd)
    };
}

const usageCache = new Map(); // subagent transcript path -> { offset, byId, first, last, totals }
const USAGE_KEYS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' };

// Folds complete JSONL lines into u. Streamed chunks repeat a message id with the same usage, so the last one per id wins.
export function addUsage(u, text) {

    for (const line of text.split('\n')) {
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const t = Date.parse(e.timestamp);
        if (t) {
            u.first = Math.min(u.first ?? t, t);
            u.last = Math.max(u.last ?? t, t);
        }
        if (e.type === 'assistant' && e.message?.usage) {
            u.byId.set(e.message.id ?? Symbol(), e.message.usage);
        }
    }

    u.totals = Object.fromEntries(Object.entries(USAGE_KEYS).map(([k, f]) => [k, [...u.byId.values()].reduce((n, x) => n + (x[f] ?? 0), 0)]));

    return u;
}

// Token totals and first/last timestamp of a transcript, reading only the bytes appended since the last call.
export async function readUsage(path, size) {

    size ??= (await stat(path)).size;
    let u = usageCache.get(path);
    if (!u || size < u.offset) {
        u = { offset: 0, byId: new Map(), first: null, last: null, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        usageCache.set(path, u);
    }

    if (size > u.offset) {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(size - u.offset);
            const { bytesRead } = await fh.read(buf, 0, buf.length, u.offset);
            // ponytail: a partial trailing line isn't buffered; the offset stops before it and the line is re-read once complete
            const end = buf.lastIndexOf(10, bytesRead - 1) + 1;
            if (end) {
                addUsage(u, buf.toString('utf8', 0, end));
                u.offset += end;
            }
        } finally {
            await fh.close();
        }
    }

    return { ...u.totals, first: u.first, last: u.last };
}

// "14m", "1h 05m"
export function formatDuration(ms) {

    const m = Math.round(ms / 60_000);

    return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "1.2M tok"
export function formatTokens(n) {

    const [d, unit] = n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'k'] : [1, ''];

    return `${+(n / d).toFixed(n >= 10 * d || d === 1 ? 0 : 1)}${unit} tok`;
}

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
        let st;
        try {
            st = await stat(path);
        } catch {
            continue;
        }
        if (now - st.mtimeMs > MAX_AGE_MS) {
            continue;
        }

        let hit = cache.get(path);
        if (!hit || hit.mtimeMs !== st.mtimeMs) {
            const meta = JSON.parse(await readFile(join(sessionDir, name), 'utf8'));
            hit = { mtimeMs: st.mtimeMs, meta, entries: (meta.spawnDepth ?? 1) > 1 ? [] : await readTail(path, st.size, AGENT_TAIL_BYTES) };
            cache.set(path, hit);
        }
        if ((hit.meta.spawnDepth ?? 1) > 1) {
            continue;
        }

        // meta.finished flips after the last transcript write, so re-read it while the agent isn't done
        if (!hit.meta.finished) {
            hit.meta = JSON.parse(await readFile(join(sessionDir, name), 'utf8'));
        }

        out.push({ id, started: st.birthtimeMs, updated: st.mtimeMs, usage: await readUsage(path, st.size), ...summarizeAgent(hit.meta, hit.entries, now - st.mtimeMs, id) });
    }

    const rank = { running: 0, stopped: 1, done: 2 };

    return out.sort((a, b) => rank[a.status] - rank[b.status] || b.updated - a.updated);
}

export function status(lastTurn, ageMs) {

    if (ageMs < WORKING_MS) {
        return 'working';
    }
    if (lastTurn?.type === 'assistant' && ageMs < WAITING_MS) {
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

export function summarize(entries, ageMs) {

    const last = type => entries.findLast(e => e.type === type);
    const turns = entries.filter(e => (e.type === 'user' || e.type === 'assistant') && !e.isSidechain);
    const meta = entries.findLast(e => e.cwd) ?? {};
    const lastTurn = turns.at(-1);

    return {
        id: meta.sessionId,
        cwd: meta.cwd,
        branch: meta.gitBranch,
        title: last('custom-title')?.customTitle ?? last('ai-title')?.aiTitle ?? null,
        pr: last('pr-link')?.prUrl ?? null,
        prs: prLinks(entries),
        model: entries.findLast(e => e.type === 'assistant')?.message?.model ?? null,
        status: status(lastTurn, ageMs),
        lastPrompt: textOf(entries.findLast(isHumanPrompt)),
        lastReply: textOf(entries.findLast(e => e.type === 'assistant' && textOf(e) && !e.isSidechain)),
        files: filesTouched(entries, meta.cwd)
    };
}

async function sessions() {

    const now = Date.now();
    const out = [];

    for (const dir of await readdir(ROOT)) {
        let files;
        try {
            files = (await readdir(join(ROOT, dir))).filter(f => f.endsWith('.jsonl'));
        } catch {
            continue;
        }

        for (const f of files) {
            const path = join(ROOT, dir, f);
            const st = await stat(path);
            if (now - st.mtimeMs > MAX_AGE_MS) {
                continue;
            }

            const s = summarize(await tailOf(path, st), now - st.mtimeMs);
            const id = s.id ?? f.replace('.jsonl', '');
            out.push({ ...s, id, dir, updated: st.mtimeMs, created: st.birthtimeMs, agents: await agents(join(ROOT, dir, id, 'subagents'), now) });
        }
    }

    await Promise.all(out.map(async s => {
        s.project = await projectOf(s.cwd);
    }));

    const urls = new Set(out.flatMap(s => [...s.prs.map(p => p.url), ...s.agents.flatMap(a => a.prs)]));
    const states = new Map(await Promise.all([...urls].map(async u => [u, await prState(u)])));
    const items = workItems(out, u => states.get(u) ?? null);
    for (const it of items) {
        // only an already fetched milestone list; /api/milestones fills it for the projects on the board
        it.milestone = milestoneOf(it.prState, swr.get(`ms:${it.project}`)?.value ?? []);
    }
    for (const s of out) {
        s.items = items.filter(i => i.sessionId === s.id);
        s.items.forEach(i => { i.folder = folderFor(i.worktreePath, s.cwd); });
        delete s.agents; // folded into items
    }

    // /clear sent from Homebase: the new transcript keeps typing into the old tmux session
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

    return out.sort((a, b) => b.updated - a.updated);
}

// The left side's lifecycle: agent stages first, then MR states.
export const LIFECYCLE = ['Implement', 'Verify', 'Review', 'Approved', 'Merged'];
const VERB = ['exploring', 'implementing', 'verifying', 'shipping', 'finishing'];

export function lifecycle(pr, prState, agent) {

    if (prState?.state === 'merged' || prState?.state === 'closed') {
        return 4;
    }
    if (prState?.ready) {
        return 3;
    }

    return pr ? 2 : [0, 0, 1, 2, 2][agent?.stage ?? 0];
}

export function itemColumn(prState, agent, hasPr) {

    if (prState?.state === 'merged' || prState?.state === 'closed') {
        return 'done';
    }
    if (agent?.status === 'running') {
        return 'doing';
    }
    if (agent?.status === 'stopped') {
        return 'needs-you';
    }

    return column('idle', prState, hasPr);
}

// What has to happen next for a work item, as one deterministic line.
export function nextStep(prState, agent) {

    if (prState?.state === 'merged') {
        return 'Merged';
    }
    if (prState?.state === 'closed') {
        return 'Closed without merging';
    }
    if (agent?.status === 'running') {
        return `${agent.description} is ${VERB[agent.stage] ?? 'working'}…`;
    }
    if (agent?.status === 'stopped') {
        return agent.stopReason === 'api-error' ? 'Agent hit an API error — continue it' : 'Agent stopped — check the chat';
    }
    if (!prState) {
        return 'Open the MR to check its state';
    }
    if (prState.changes) {
        const by = prState.changesBy?.length ? prState.changesBy : prState.reviewers ?? [];
        return by.length ? `Address review comments from ${by.join(', ')}` : 'Address review comments';
    }
    if (prState.ci === 'failing') {
        return 'Pipeline failing';
    }
    if (prState.ci === 'running') {
        return 'Pipeline running';
    }
    if (prState.draft) {
        return 'Draft — mark it ready for review';
    }
    if (prState.ready) {
        return 'Approved — merge it';
    }

    return prState.reviewers?.length ? `Waiting for review by ${prState.reviewers.join(', ')}` : 'Needs a reviewer';
}

// The one-click command for a work item's row, as { label, message } typed into its session, or null when nothing is on you.
export function rowAction(pr, prState, agent, title) {

    if (agent?.status === 'running') {
        return null;
    }
    if (!pr) {
        return agent?.status === 'stopped'
            ? { label: 'Continue', message: `The subagent '${title}' stopped — check why and continue it.` }
            : null;
    }
    if (prState?.state !== 'open') {
        return null;
    }

    const n = pr.match(/(?:merge_requests|pull)\/(\d+)/)?.[1];
    const ref = `${pr.includes('/pull/') ? '#' : '!'}${n} (${pr})`;
    if (prState.changes) {
        return { label: 'Fix & reply', message: `Address the review comments on ${ref}, push, and reply in each thread.` };
    }
    if (prState.ci === 'failing') {
        return { label: 'Fix pipeline', message: `The pipeline on ${ref} is failing — find out why and fix it.` };
    }
    if (prState.ready) {
        return { label: 'Merge + close issue', message: `Merge ${ref} and close its issue.` };
    }
    if (!prState.reviewers?.length && !prState.draft) {
        return { label: 'Request review', message: `Assign a reviewer to ${ref} — suggest who.` };
    }

    return null;
}

// One item per PR/MR (deduped across sessions and agents), plus running or stopped agents with no MR yet.
// Agents whose description names a known MR (!123) count as work on it; finished agents without an MR are dropped.
// A report that merely quotes another repo's MR (e.g. a Homebase agent citing a pracsys MR) isn't work on this project.
export function sameRepo(url, project) {
    return url.match(/^https:\/\/[^/]+\/(.+?)(?:\/-)?\/(?:merge_requests|pull)\//)?.[1].split('/').pop() === project;
}

export function workItems(sessions, prOf = () => null, now = Date.now()) {

    const byUrl = new Map();
    const add = (url, project) => {
        if (!byUrl.has(url)) {
            byUrl.set(url, { key: url, pr: url, project, agents: [], linkedAt: 0, linkSession: null });
        }

        return byUrl.get(url);
    };

    for (const s of sessions) {
        for (const { url, at } of s.prs ?? []) {
            const it = add(url, s.project);
            if (!it.linkSession || at > it.linkedAt) {
                Object.assign(it, { linkedAt: at, linkSession: s.id });
            }
        }
        for (const a of s.agents ?? []) {
            for (const url of (a.prs ?? []).filter(u => sameRepo(u, s.project))) {
                add(url, s.project);
            }
        }
    }

    const byRef = new Map([...byUrl.values()].map(it => [`${it.project}!${it.pr.match(/merge_requests\/(\d+)/)?.[1]}`, it]));
    const loose = [];
    for (const s of sessions) {
        for (const a of s.agents ?? []) {
            const own = { ...a, sessionId: s.id };
            const refs = new Set((a.prs ?? []).filter(u => sameRepo(u, s.project)).map(u => byUrl.get(u)).filter(Boolean));
            for (const m of (a.description ?? '').matchAll(/!(\d+)/g)) {
                const it = byRef.get(`${s.project}!${m[1]}`);
                if (it) {
                    refs.add(it);
                }
            }

            if (refs.size) {
                refs.forEach(it => it.agents.push(own));
            } else if (a.status !== 'done') {
                loose.push({ key: a.id, pr: null, project: s.project, agents: [own], linkedAt: 0, linkSession: null });
            }
        }
    }

    return [...byUrl.values(), ...loose].map(it => {

        const agents = it.agents.toSorted((a, b) => b.updated - a.updated);
        const agent = agents[0] ?? null;
        const prState = it.pr ? prOf(it.pr) : null;
        const stage = lifecycle(it.pr, prState, agent);
        const col = itemColumn(prState, agent, !!it.pr);
        const title = prState?.title ?? agent?.description ?? it.pr;
        const tokens = Object.fromEntries(Object.keys(USAGE_KEYS).map(k => [k, agents.reduce((n, a) => n + (a.usage?.[k] ?? 0), 0)]));
        const total = Object.values(tokens).reduce((a, b) => a + b, 0);
        // summed per agent, so idle gaps between agents don't count; a running agent counts up to now
        const timeMs = agents.reduce((n, a) => n + (a.usage?.first != null ? (a.status === 'running' ? now : a.usage.last) - a.usage.first : 0), 0);

        return {
            key: it.key,
            project: it.project,
            sessionId: agent?.sessionId ?? it.linkSession,
            title,
            pr: it.pr,
            prState,
            column: col,
            stage,
            stageLabel: prState?.state === 'closed' ? 'Closed' : LIFECYCLE[stage],
            agentStatus: agent?.status ?? null,
            updated: Math.max(agent?.updated ?? 0, it.linkedAt),
            branch: prState?.branch ?? agent?.branch ?? null, // transcript gitBranch is unreliable inside worktrees
            worktreePath: agent?.worktreePath ?? null,
            tldr: agent?.tldr ?? null,
            body: agent?.body ?? '',
            files: agent?.files ?? [],
            activity: agents.slice(1).map(a => ({ id: a.id, description: a.description, status: a.status, tldr: a.tldr })),
            next: nextStep(prState, agent),
            action: rowAction(it.pr, prState, agent, title),
            tokens: total ? formatTokens(total) : null,
            tokensTitle: total ? `input ${tokens.input.toLocaleString('en')} · output ${tokens.output.toLocaleString('en')} · cache read ${tokens.cacheRead.toLocaleString('en')} · cache write ${tokens.cacheWrite.toLocaleString('en')}` : null,
            time: timeMs > 0 ? formatDuration(timeMs) : null
        };
    });
}

// Milestones: read-only glab/gh calls, cached per project, per milestone's issue list and per open issue's linked MRs.
const MS_LIST_TTL_MS = 5 * 60_000;
const MS_ISSUES_TTL_MS = 90_000;
const MS_LINKS_TTL_MS = 5 * 60_000;
const MS_PARALLEL = 8;
const swr = new Map(); // key -> { at, value, pending, error }

// Runs at most n of the given async functions at a time; the rest wait in call order.
export function limiter(n) {

    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= n || !queue.length) {
            return;
        }
        active++;
        const { fn, resolve, reject } = queue.shift();
        Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            active--;
            next();
        });
    };

    return fn => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

// Concurrent calls with the same key share one promise; a call after it settled starts afresh.
export function dedupe() {

    const live = new Map();

    return (key, fn) => {
        if (!live.has(key)) {
            live.set(key, Promise.resolve().then(fn).finally(() => live.delete(key)));
        }

        return live.get(key);
    };
}

// Starts a refresh when the entry is stale and returns the entry ({ value, pending, error }) without waiting.
function refresh(key, ttl, fn) {

    let hit = swr.get(key);
    if (!hit) {
        hit = { at: 0, value: null };
        swr.set(key, hit);
    }
    if (Date.now() - hit.at > ttl && !hit.pending) {
        hit.pending = fn()
            .then(v => { hit.value = v; hit.error = null; })
            .catch(e => { hit.error = e; })
            .finally(() => { hit.at = Date.now(); hit.pending = null; });
    }

    return hit;
}

// Stale-while-revalidate like prState, for any key. Only the first load waits; a failed first load throws.
async function cached(key, ttl, fn) {

    const hit = refresh(key, ttl, fn);
    if (hit.value === null) {
        await hit.pending;
    }
    if (hit.value === null && hit.error) {
        throw hit.error;
    }

    return hit.value;
}

const isGitLab = repo => repo.host.includes('gitlab');
// Every glab/gh call goes through one limiter, and an identical call already in flight is shared.
const apiSlot = limiter(MS_PARALLEL);
const apiOnce = dedupe();
const api = (repo, path) => {

    const cli = isGitLab(repo) ? 'glab' : 'gh';

    return apiOnce(`${cli} ${path}`, () => apiSlot(() => run(cli, ['api', path]))).then(({ stdout }) => JSON.parse(stdout));
};
export const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Open milestones with their issue counts (closed/total) for the selector menu.
async function fetchMilestones(repo) {

    if (isGitLab(repo)) {
        const p = encodeURIComponent(repo.path);
        const list = await api(repo, `projects/${p}/milestones?state=active&include_ancestors=true&per_page=100`);
        // ponytail: counts by title, so a same-titled group milestone would add to them; exact counts need each milestone's issue list
        return Promise.all(list.map(async m => {
            const c = (await api(repo, `projects/${p}/issues_statistics?milestone=${encodeURIComponent(m.title)}`).catch(() => null))?.statistics?.counts;
            return { id: m.id, title: m.title, due: m.due_date ?? null, url: m.web_url, group: !!m.group_id, closed: c?.closed ?? null, total: c?.all ?? null };
        }));
    }
    const list = await api(repo, `repos/${repo.path}/milestones?state=open&per_page=100`);

    return list.map(m => ({ id: m.number, title: m.title, due: m.due_on?.slice(0, 10) ?? null, url: m.html_url, closed: m.closed_issues, total: m.open_issues + m.closed_issues }));
}

// Every page of a list endpoint, 100 per page.
async function pages(repo, path) {

    const out = [];
    for (let page = 1; ; page++) {
        const list = await api(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
        out.push(...list);
        if (list.length < 100) {
            return out;
        }
    }
}

// Only issues whose own milestone is the selected one; the API's milestone filter is not trusted on its own.
export const keepMilestone = (issues, id) => issues.filter(i => i.milestone === id);

// { name, username } of a GitLab user or a GitHub login (GitHub's issue payload has no display name).
const person = u => ({ name: u.name ?? u.login, username: u.username ?? u.login });

// Plain-text start of an issue description, about max chars, for the expanded card: markdown marks, links and headings dropped.
export function excerpt(md, max = 300) {

    const t = (md || '').replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^(#+\s|\|).*$/gm, ' ').replace(/[*`>#]+|__/g, '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) {
        return t;
    }

    return t.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

async function fetchIssues(repo, ms) {

    if (isGitLab(repo)) {
        const p = encodeURIComponent(repo.path);
        // a project milestone by id; a group milestone has no project-scoped endpoint, so by title, then filtered by id
        const path = ms.group ? `projects/${p}/issues?milestone=${encodeURIComponent(ms.title)}&state=all` : `projects/${p}/milestones/${ms.id}/issues`;
        const list = (await pages(repo, path)).map(i => ({ iid: i.iid, title: i.title, state: i.state === 'closed' ? 'closed' : 'open', assignees: (i.assignees ?? []).map(person), url: i.web_url, milestone: i.milestone?.id, desc: excerpt(i.description), updated: i.updated_at }));
        return keepMilestone(list, ms.id);
    }
    const list = (await pages(repo, `repos/${repo.path}/issues?milestone=${ms.id}&state=all`)).filter(i => !i.pull_request)
        .map(i => ({ iid: i.number, title: i.title, state: i.state, assignees: (i.assignees ?? []).map(person), url: i.html_url, milestone: i.milestone?.number, desc: excerpt(i.body), updated: i.updated_at }));

    return keepMilestone(list, ms.id);
}

// An MR works on an issue when its title or source branch names the issue number ("#2223 - …", "2223-fix-…").
// related_merge_requests also returns MRs that only mention the issue in a description or comment.
export const worksOn = (mr, iid) => new RegExp(`(^|\\D)${iid}(\\D|$)`).test(`${mr.title} ${mr.source_branch}`);

// ponytail: GitHub's linked PRs need GraphQL, so GitHub issues are never "in progress" or "can be closed"
async function fetchLinks(repo, iid) {

    const list = await api(repo, `projects/${encodeURIComponent(repo.path)}/issues/${iid}/related_merge_requests`);

    // the author is who works on it, for in-progress issues nobody is assigned to; the payload carries the pipeline too
    return list.filter(m => worksOn(m, iid)).map(m => ({
        iid: m.iid, url: m.web_url, state: { opened: 'open' }[m.state] ?? m.state,
        author: m.author ? person(m.author) : null, pipeline: pipelineOf(m.head_pipeline ?? m.pipeline)
    }));
}

// Issues of a milestone in the order the user acts on them. links: iid -> [{ state: open|merged|closed }] for open issues.
// An open MR wins over a merged one: a follow-up still in review means the issue isn't done.
export function groupIssues(issues, links = {}) {

    const groups = { closable: [], doing: [], assigned: [], unassigned: [], done: [] };
    for (const i of issues) {
        const mrs = links[i.iid] ?? [];
        const key = i.state === 'closed' ? 'done'
            : mrs.some(m => m.state === 'open') ? 'doing'
            : mrs.some(m => m.state === 'merged') ? 'closable'
            : i.assignees.length ? 'assigned' : 'unassigned';
        groups[key].push({ ...i, mrs });
    }

    return { total: issues.length, closed: groups.done.length, groups };
}

// Milestone { id, title } of an MR: its own milestone, else the listed one whose slug is its target branch (supplier-automation).
export function milestoneOf(pr, list) {

    const m = pr && (pr.milestone ?? list.find(m => slug(m.title) === pr.target));

    return m ? { id: m.id, title: m.title } : null;
}

// Ids of listed milestones that the board's MRs belong to, open MRs weighing most.
export function activeMilestones(mrs, list) {

    const score = new Map();
    for (const mr of mrs) {
        const id = milestoneOf(mr, list)?.id;
        if (list.some(m => m.id === id)) {
            score.set(id, (score.get(id) ?? 0) + (mr.state === 'open' ? 10 : 1));
        }
    }

    return [...score].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// The issue groups of one milestone; its open issues' MRs in parallel (api's limiter bounds them).
async function milestoneIssues(project, repo, ms) {

    const issues = await fetchIssues(repo, ms);
    const links = {};
    if (isGitLab(repo)) {
        await Promise.all(issues.filter(i => i.state === 'open').map(async ({ iid }) => {
            links[iid] = await cached(`links:${project}:${iid}`, MS_LINKS_TTL_MS, () => fetchLinks(repo, iid)).catch(() => []);
        }));
    }

    return groupIssues(issues, links);
}

// A project's open milestones, the ids its MRs point at, and the issue groups of the chosen one.
// pick: a milestone id (or a title, as older saved choices hold), "none" for no milestone, empty for the most active one.
async function milestones(project, pick) {

    // right after start the projects come from the warm-up's session scan
    if (!repoPaths.has(project)) {
        await scanned;
    }
    const repo = repoPaths.get(project);
    if (!repo) {
        throw Object.assign(new Error('unknown project'), { status: 404 });
    }

    // the signed-in user, for the Issues tab's "you" lane; a failed lookup only loses the mark
    const [list, me] = await Promise.all([
        cached(`ms:${project}`, MS_LIST_TTL_MS, () => fetchMilestones(repo)),
        cached(`me:${repo.host}`, 24 * 3600_000, () => api(repo, 'user').then(person)).catch(() => null)
    ]);
    const mrs = [...prs].filter(([url, hit]) => hit.value && sameRepo(url, project)).map(([, hit]) => hit.value);
    const detected = activeMilestones(mrs, list);
    const ms = pick === 'none' ? null : list.find(m => String(m.id) === pick || m.title === pick) ?? list.find(m => m.id === detected[0]);

    // the issue groups never wait: until the first load is in, selected has the list's counts and loading: true
    const issues = ms && refresh(`issues:${project}:${ms.id}`, MS_ISSUES_TTL_MS, () => milestoneIssues(project, repo, ms));
    const selected = !ms ? null : issues.value ? { ...ms, ...issues.value } : { ...ms, loading: !!issues.pending, error: issues.error?.message ?? null };
    const updating = !!(issues?.pending || swr.get(`ms:${project}`).pending);

    return { project, milestones: list, detected, me, selected, updating };
}

// Session scan at start, so /api/milestones knows the projects and the board's MRs before the page asks.
let scanned = Promise.resolve();

// Fills the milestone caches in the background for every project seen in recent sessions: the list, and the issues of its most active milestone.
// ponytail: only the detected milestone's issues; another one loads on first pick (counts show at once, issues follow)
function warmMilestones() {

    scanned = sessions().catch(() => {});
    scanned.then(() => Promise.all([...repoPaths.keys()].map(p => milestones(p, '').catch(() => {}))));
}

// HOMEBASE_STATUSLINE_DIR lets a test server read sample dumps instead of the real folder.
const STATUS_DIR = process.env.HOMEBASE_STATUSLINE_DIR ?? join(homedir(), '.claude', 'homebase', 'statusline');

// Status-line JSON -> { fiveHour, sevenDay: { used, resetsAt } }; windows past their reset are dropped, as Claude Code does.
export function limitsOf(j, now = Date.now()) {

    const win = w => (typeof w?.used_percentage === 'number' && w.resets_at * 1000 > now ? { used: w.used_percentage, resetsAt: w.resets_at * 1000 } : null);
    const out = { fiveHour: win(j?.rate_limits?.five_hour), sevenDay: win(j?.rate_limits?.seven_day) };

    return out.fiveHour || out.sevenDay ? out : null;
}

// Highest used % seen per window, keyed by name and resets_at. Dumps are per session and can be stale, so a dump
// must never lower the number within a window; a new resets_at starts fresh. Expired windows are dropped.
export function peakLimits(peaks, dumps, now = Date.now()) {

    for (const j of dumps) {
        for (const [name, w] of Object.entries(limitsOf(j, now) ?? {})) {
            if (w) {
                const k = `${name}:${w.resetsAt}`;
                peaks.set(k, Math.max(peaks.get(k) ?? 0, w.used));
            }
        }
    }
    for (const k of peaks.keys()) {
        if (Number(k.split(':')[1]) <= now) {
            peaks.delete(k);
        }
    }

    const current = name => {
        const resets = [...peaks.keys()].filter(k => k.startsWith(`${name}:`)).map(k => Number(k.split(':')[1]));
        if (!resets.length) {
            return null;
        }
        const resetsAt = Math.max(...resets);

        return { used: peaks.get(`${name}:${resetsAt}`), resetsAt };
    };
    const out = { fiveHour: current('fiveHour'), sevenDay: current('sevenDay') };

    return out.fiveHour || out.sevenDay ? out : null;
}

const limitPeaks = new Map();

// Rate limits from every status-line dump (written by scripts/statusline.sh), plus when the newest one was written.
// ponytail: one file per session accumulates in STATUS_DIR and all are read each poll; prune old ones if the folder ever gets big
async function limits() {

    let names;
    try {
        names = (await readdir(STATUS_DIR)).filter(n => n.endsWith('.json'));
    } catch {
        return null;
    }

    const dumps = [];
    let updated = 0;
    for (const n of names) {
        try {
            const path = join(STATUS_DIR, n);
            const j = JSON.parse(await readFile(path, 'utf8'));
            if (limitsOf(j)) {
                dumps.push(j);
                updated = Math.max(updated, (await stat(path)).mtimeMs);
            }
        } catch {}
    }
    const out = peakLimits(limitPeaks, dumps);

    return out && { ...out, updated };
}

async function transcript(dir, id) {

    const path = join(ROOT, dir, `${id}.jsonl`);
    if (!path.startsWith(ROOT + '/') || dir.includes('/') || id.includes('/')) {
        throw new Error('bad path');
    }

    const st = await stat(path);
    const entries = await tailOf(path, st);

    return { items: chatItems(entries), asking: pendingQuestion(entries), questions: pendingAsk(entries), working: Date.now() - st.mtimeMs < WORKING_MS };
}

// Open in editor: the item's agent worktree if it's still there, else its session's cwd. Absolute paths only, so none reads as a flag.
export const folderFor = (worktreePath, cwd, exists = existsSync) => [worktreePath, cwd].find(p => p?.startsWith('/') && exists(p)) ?? null;

const EDITORS = [
    { id: 'idea', name: 'IntelliJ IDEA', app: /^IntelliJ IDEA.*\.app$/, cli: 'idea' },
    { id: 'vscode', name: 'VS Code', app: /^Visual Studio Code.*\.app$/, cli: 'code' }
];
// apps: .app paths found; clis: command name -> path. An app wins (open -a), else the CLI.
export function editorsFrom(apps, clis) {
    return EDITORS.flatMap(e => {
        const app = apps.find(a => e.app.test(basename(a)));
        const cmd = app ? ['open', ['-a', app]] : clis[e.cli] ? [clis[e.cli], []] : null;

        return cmd ? [{ id: e.id, name: e.name, cmd }] : [];
    });
}

async function detectEditors() {

    const appDirs = ['/Applications', join(homedir(), 'Applications'), join(homedir(), 'Applications', 'JetBrains Toolbox')];
    const apps = (await Promise.all(appDirs.map(d => readdir(d).then(fs => fs.map(f => join(d, f)), () => [])))).flat();

    const binDirs = [...(process.env.PATH ?? '').split(':').filter(Boolean), join(homedir(), 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts')];
    const clis = {};
    for (const name of EDITORS.map(e => e.cli)) {
        for (const d of binDirs) {
            const ok = await access(join(d, name), constants.X_OK).then(() => true, () => false);
            if (ok) {
                clis[name] = join(d, name);
                break;
            }
        }
    }

    return editorsFrom(apps, clis);
}
let editorList = null;
const editors = () => (editorList ??= detectEditors());

// Only known items, only the folder the server resolved; the client names an item and an editor, never a path.
export async function openInEditor(key, editorId, { list = sessions, eds = editors, exec = run } = {}) {

    const ed = (await eds()).find(e => e.id === editorId);
    if (!ed) {
        throw Object.assign(new Error('unknown editor'), { status: 400 });
    }

    const it = (await list()).flatMap(s => s.items ?? []).find(i => i.key === key);
    if (!it?.folder) {
        throw Object.assign(new Error(it ? 'folder is gone' : 'unknown item'), { status: 404 });
    }

    await exec(ed.cmd[0], [...ed.cmd[1], it.folder]);
}

// Only known sessions, only their recorded cwd.
async function resumable(id) {

    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) {
        throw new Error('bad id');
    }

    const s = (await sessions()).find(x => x.id === id);
    if (!s?.cwd) {
        throw new Error('unknown session');
    }
    try {
        await stat(s.cwd);
    } catch {
        throw new Error(`folder is gone: ${s.cwd}`);
    }

    return s;
}

// ponytail: login+interactive zsh so PATH matches your terminal; id is validated, cwd is passed as its own arg
const claudeCmd = id => ['/bin/zsh', '-lic', `claude --resume ${id}`];

// tmux keeps Claude running between messages; `tmux attach -t cc-<id8>` reaches it from any terminal.
const tmuxName = id => `cc-${id.slice(0, 8)}`;

// /clear starts a new session id in the same process, so the new id keeps the old tmux name.
// ponytail: in memory; after a server restart a cleared session gets its own tmux on the next send
const aliases = new Map(); // new session id -> { tmux, from }
const clears = []; // pending { from, tmux, cwd, clearedAt }, until the new transcript shows up
const CLEAR_WAIT_MS = 60_000;

export const tmuxFor = (id, map = aliases) => map.get(id)?.tmux ?? tmuxName(id);

// The newest transcript in the same cwd created after a /clear (within CLEAR_WAIT_MS): the cleared session's successor.
// ponytail: a session started by hand in the same folder within that minute could be mistaken for it
export function findClearedSuccessor(sessions, { from, cwd, clearedAt }) {

    const hits = sessions.filter(s => s.id !== from && s.cwd === cwd && s.created >= clearedAt && s.created - clearedAt < CLEAR_WAIT_MS);

    return hits.sort((a, b) => b.created - a.created)[0] ?? null;
}
const tmuxSession = (id, cwd) => ['-s', tmuxName(id), '-c', cwd, ...claudeCmd(id)];

const MAX_SEND = 20 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// tmux argument lists that type `text` into session `name` and submit it. Multi-line text goes in as one
// bracketed paste, since a literal newline would submit the first line on its own.
export function sendSteps(name, text) {

    const clean = text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim();
    if (!clean) {
        throw new Error('empty message');
    }

    const enter = ['send-keys', '-t', name, 'Enter'];
    if (!clean.includes('\n')) {
        return [['send-keys', '-t', name, '-l', '--', clean], enter];
    }

    return [['set-buffer', '-b', name, '--', clean], ['paste-buffer', '-p', '-d', '-b', name, '-t', name], enter];
}

const LIVE_ELSEWHERE_MS = 2 * 60_000;

// A recently written transcript without our tmux session means Claude runs in another terminal; a second one would share the transcript.
export function refuseIfLiveElsewhere(ageMs) {

    if (ageMs < LIVE_ELSEWHERE_MS) {
        throw Object.assign(new Error('This session is open in another terminal. Close it there first.'), { status: 409 });
    }
}

async function send(id, text, s = null) {

    s ??= await resumable(id);
    let name = tmuxFor(id);
    let steps = sendSteps(name, text);

    try {
        await tmux(['has-session', '-t', `=${name}`]);
    } catch {
        aliases.delete(id); // the aliased tmux session is gone: start one of its own
        name = tmuxName(id);
        steps = sendSteps(name, text);
        refuseIfLiveElsewhere(Date.now() - s.updated);
        await tmux(['new-session', '-d', ...tmuxSession(id, s.cwd)]);
        await sleep(5000); // ponytail: fixed wait for claude to boot; poll capture-pane for its prompt if this proves flaky
    }

    for (const args of steps) {
        if (args.at(-1) === 'Enter') {
            await sleep(300); // a separate, later Enter so Claude doesn't treat it as part of the typed/pasted text
        }
        await tmux(args);
    }

    return name;
}

// Escape interrupts Claude's turn, so queued messages are handled right away. Only in our own tmux session.
async function interrupt(id) {

    await resumable(id);
    const name = tmuxFor(id);

    try {
        await tmux(['has-session', '-t', `=${name}`]);
    } catch {
        throw Object.assign(new Error("Session isn't running in Homebase's tmux"), { status: 409 });
    }

    await tmux(['send-keys', '-t', name, 'Escape']);
}

// Types /clear (same checks as send) and remembers it, so the next session list maps the new transcript to this tmux session.
async function clearChat(id) {

    const s = await resumable(id);
    const c = { from: id, tmux: tmuxFor(id), cwd: s.cwd, clearedAt: Date.now() };
    clears.push(c);
    try {
        c.tmux = await send(id, '/clear', s); // send may have replaced a dead aliased tmux session
    } catch (e) {
        clears.splice(clears.indexOf(c), 1);
        throw e;
    }
}

async function readBody(req, max) {

    let data = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
        data += chunk;
        if (data.length > max) {
            throw new Error('message too long');
        }
    }

    return data;
}

// The page's files. A fixed map, so no request path ever reaches the file system.
const JS = 'text/javascript; charset=utf-8';
const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', JS],
    '/core.js': ['core.js', JS],
    '/list.js': ['list.js', JS],
    '/chat.js': ['chat.js', JS],
    '/milestone.js': ['milestone.js', JS],
    '/issues.js': ['issues.js', JS],
    '/keys.js': ['keys.js', JS],
    '/icon.svg': ['icon.svg', 'image/svg+xml']
};

// No third-party origins: everything, Web Awesome included, comes from public/vendor. data: is for Web Awesome's
// built-in icons, which it renders as data: SVG URLs and loads with fetch(). Its components set inline styles.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Third-party code copied into public/vendor (see VENDOR.md). Only these extensions are ever served from there.
const VENDOR_DIR = fileURLToPath(new URL('./public/vendor', import.meta.url));
const VENDOR_TYPES = {
    '.js': JS,
    '.mjs': JS,
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.json': 'application/json'
};

// '/vendor/a/b.js' -> 'a/b.js', or null for anything that could leave public/vendor or isn't an allowed type.
// Pure: symlinks are checked against the real path when serving.
export function vendorPath(urlPath) {

    if (typeof urlPath !== 'string' || !urlPath.startsWith('/vendor/')) {
        return null;
    }

    let rel;
    try {
        rel = decodeURIComponent(urlPath.slice('/vendor/'.length));
    } catch {
        return null;
    }

    // no '..', '.', dotfiles, empty segments, backslashes or NULs
    const bad = rel.split('/').some(p => p === '' || p.startsWith('.')) || /[\\\0]/.test(rel);
    if (bad || !Object.hasOwn(VENDOR_TYPES, extname(rel))) {
        return null;
    }

    return rel;
}

async function serveVendor(rel, res) {

    const root = await realpath(VENDOR_DIR);
    const file = await realpath(join(root, rel)).catch(() => null);
    if (!file?.startsWith(root + sep)) {
        return false;
    }

    res.setHeader('content-type', VENDOR_TYPES[extname(file)]);
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(await readFile(file));

    return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    editors();
    warmMilestones();
    createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        try {
            const file = Object.hasOwn(STATIC, url.pathname) && STATIC[url.pathname]; // not __proto__ and friends
            if (file) {
                res.setHeader('content-type', file[1]);
                res.setHeader('x-content-type-options', 'nosniff');
                if (file[1].startsWith('text/html')) {
                    res.setHeader('content-security-policy', CSP);
                }
                return res.end(await readFile(new URL(`./public/${file[0]}`, import.meta.url)));
            }
            const vendored = vendorPath(url.pathname);
            if (vendored && await serveVendor(vendored, res)) {
                return;
            }
            if (url.pathname === '/api/sessions') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify(await sessions()));
            }
            // POST + custom header: a cross-origin page can't send this without a preflight we never answer
            if (url.pathname === '/api/send' && req.method === 'POST' && req.headers['x-codetool'] === '1') {
                await send(url.searchParams.get('id'), await readBody(req, MAX_SEND));
                return res.end('ok');
            }
            if (url.pathname === '/api/clear' && req.method === 'POST' && req.headers['x-codetool'] === '1') {
                await clearChat(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (url.pathname === '/api/interrupt' && req.method === 'POST' && req.headers['x-codetool'] === '1') {
                await interrupt(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (url.pathname === '/api/open' && req.method === 'POST' && req.headers['x-codetool'] === '1') {
                await openInEditor(url.searchParams.get('item'), url.searchParams.get('editor'));
                return res.end('ok');
            }
            if (url.pathname === '/api/editors') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify((await editors()).map(({ id, name }) => ({ id, name }))));
            }
            if (url.pathname === '/api/milestones') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify(await milestones(url.searchParams.get('project'), url.searchParams.get('milestone'))));
            }
            if (url.pathname === '/api/limits') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify(await limits()));
            }
            if (url.pathname === '/api/transcript') {
                res.setHeader('content-type', 'application/json');
                return res.end(JSON.stringify(await transcript(url.searchParams.get('dir'), url.searchParams.get('id'))));
            }
            res.statusCode = 404;
            res.end('not found');
        } catch (e) {
            res.statusCode = e.status ?? 500;
            res.end(String(e.message));
        }
    }).listen(PORT, '127.0.0.1', () => console.log(`Homebase on http://localhost:${PORT}`));
}
