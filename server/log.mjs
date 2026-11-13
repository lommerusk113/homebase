// Log tab: one project's last 7 days, newest first and grouped by day, for GET /api/log. Read-only sources: finished
// subagents (with the commits they made nested), git commits in the main checkout, the master chat's ▸ topics, and
// merged or closed MRs.
import { readdir, stat, readFile, open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT, readTail, readUsage, textOf, splitTopic, splitTldr, USAGE_KEYS, formatDuration, formatTokens } from './transcripts.mjs';
import { projectOf, summarizeAgent } from './sessions.mjs';
import { prState } from './forge.mjs';

const run = promisify(execFile);

const LOG_MS = 7 * 864e5;
const GIT_TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 5_000;
const HEAD_BYTES = 64 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const AGENT_TAIL_BYTES = 128 * 1024;
const SEP = '\x1f';

// ---- pure helpers ----

// `git log --source --format=%H<US>%h<US>%ct<US>%S<US>%s` -> [{ hash, short, at, ref, subject }]
export function parseLog(stdout) {

    return stdout.split('\n').filter(Boolean).map(line => {
        const [hash, short, ct, ref, ...subject] = line.split(SEP);
        return { hash, short, at: Number(ct) * 1000, ref, subject: subject.join(SEP) };
    });
}

// refs/heads/x, refs/remotes/origin/x and refs/tags/x -> x
export const branchOf = ref => (ref ?? '').replace(/^refs\/(?:heads|tags)\//, '').replace(/^refs\/remotes\/[^/]+\//, '');

// local: `rev-list --branches --not --remotes` (commits no remote ref has); unpushed: the same for the default branch.
// Without remote refs nothing can be pushed, so pushed is null and nothing gets a badge.
export function markPushed(commits, local, unpushed, defaultBranch, hasRemote) {

    const lines = s => new Set(s.split('\n').filter(Boolean));
    const localSet = lines(local), unpushedSet = lines(unpushed);

    return commits.map(c => ({
        ...c,
        branch: unpushedSet.has(c.hash) ? defaultBranch : branchOf(c.ref),
        pushed: hasRemote ? !localSet.has(c.hash) : null,
        unpushed: hasRemote && unpushedSet.has(c.hash)
    }));
}

// Claude's ▸ topic replies as one milestone per topic change, with the newest TLDR said under it.
// notes: [{ at, topic, tldr }] in transcript order; a reply without a topic only adds its TLDR to the current one.
export function chatMilestones(notes) {

    const out = [];
    for (const n of notes) {
        const cur = out.at(-1);
        if (n.topic && n.topic !== cur?.topic) {
            out.push({ at: n.at, topic: n.topic, tldr: n.tldr ?? null });
        } else if (cur && (n.topic || n.tldr)) {
            cur.at = n.at;
            cur.tldr = n.tldr ?? cur.tldr;
        }
    }

    return out;
}

// Commits an agent made go under it: its worktree branch, else its report naming the hash of a commit made while it
// ran (the earliest such agent wins, since later ones, e.g. a merge agent, refer back to it). Returns the rest.
const SLACK_MS = 60_000;
export function nestCommits(agents, commits) {

    const byAge = [...agents].sort((a, b) => a.at - b.at);
    const left = [];
    for (const c of commits) {
        const named = new RegExp(`\\b${c.hash.slice(0, 7)}[0-9a-f]*\\b`);
        const ran = a => c.at >= (a.started ?? a.at) - SLACK_MS && c.at <= a.at + SLACK_MS;
        const owner = byAge.find(a => a.branches.includes(c.branch)) ?? byAge.find(a => ran(a) && named.test(a.report));
        if (owner) {
            owner.commits.push(c);
        } else {
            left.push(c);
        }
    }

    return left;
}

const dayKey = t => new Date(t).toDateString();

// [{ label: 'Today' | 'Yesterday' | 'Monday 9 Nov', entries }], newest day and entry first.
export function groupByDay(entries, now = Date.now()) {

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const names = { [dayKey(now)]: 'Today', [dayKey(yesterday)]: 'Yesterday' };
    const days = new Map();
    for (const e of [...entries].sort((a, b) => b.at - a.at)) {
        const k = dayKey(e.at);
        if (!days.has(k)) {
            days.set(k, { label: names[k] ?? new Date(e.at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }).replace(',', ''), entries: [] });
        }
        days.get(k).entries.push(e);
    }

    return [...days.values()];
}

// ---- readers ----

const cwds = new Map(); // transcript path -> cwd (from its first lines)
async function cwdOf(path) {

    if (!cwds.has(path)) {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(HEAD_BYTES);
            const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
            const m = buf.toString('utf8', 0, bytesRead).match(/"cwd":("(?:[^"\\]|\\.)*")/);
            // ponytail: a transcript whose first 64 KB name no cwd is left out of every project's log
            cwds.set(path, m ? JSON.parse(m[1]) : null);
        } finally {
            await fh.close();
        }
    }

    return cwds.get(path);
}

// Topic/TLDR replies and MR links of a master transcript, reading only bytes appended since the last call. Only lines
// that can hold one are parsed, so a first read of a 70 MB transcript stays cheap.
const chats = new Map(); // transcript path -> { offset, notes, links }
function noteLines(c, text) {

    for (const line of text.split('\n')) {
        if (!/▸|TL;?DR|"pr-link"/.test(line)) {
            continue;
        }
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const at = Date.parse(e.timestamp) || 0;
        if (e.type === 'pr-link' && e.prUrl) {
            c.links.set(e.prUrl, Math.max(c.links.get(e.prUrl) ?? 0, at));
        } else if (e.type === 'assistant' && !e.isSidechain && textOf(e)) {
            const { topic, text } = splitTopic(textOf(e)), { tldr } = splitTldr(text);
            if (topic || tldr) {
                c.notes.push({ at, topic, tldr });
            }
        }
    }
}

async function scanChat(path, size) {

    let c = chats.get(path);
    if (!c || size < c.offset) {
        c = { offset: 0, notes: [], links: new Map() };
        chats.set(path, c);
    }

    if (size > c.offset) {
        const fh = await open(path, 'r');
        try {
            for (let len = CHUNK_BYTES; c.offset < size;) {
                const buf = Buffer.alloc(Math.min(len, size - c.offset));
                const { bytesRead } = await fh.read(buf, 0, buf.length, c.offset);
                const end = buf.lastIndexOf(10, bytesRead - 1) + 1;
                if (!end) {
                    if (buf.length >= size - c.offset) {
                        break; // a partial last line, re-read once complete
                    }
                    len *= 2;
                    continue;
                }
                noteLines(c, buf.toString('utf8', 0, end));
                c.offset += end;
            }
        } finally {
            await fh.close();
        }
    }

    return c;
}

const agentCache = new Map(); // finished subagent transcript path -> { mtimeMs, value }
async function finishedAgents(sessionDir, since) {

    let names;
    try {
        names = (await readdir(sessionDir)).filter(f => f.endsWith('.meta.json'));
    } catch {
        return [];
    }

    const out = [];
    for (const name of names) {
        const id = name.replace('.meta.json', ''), path = join(sessionDir, `${id}.jsonl`);
        try {
            const st = await stat(path);
            if (st.mtimeMs < since) {
                continue;
            }
            let hit = agentCache.get(path);
            if (hit?.mtimeMs !== st.mtimeMs) {
                const meta = JSON.parse(await readFile(join(sessionDir, name), 'utf8'));
                if (!meta.finished || (meta.spawnDepth ?? 1) > 1) {
                    continue; // still running (the Work tab shows it), or a helper's helper
                }
                const a = summarizeAgent(meta, await readTail(path, st.size, AGENT_TAIL_BYTES, AGENT_TAIL_BYTES), 0);
                const u = await readUsage(path, st.size);
                const tokens = Object.keys(USAGE_KEYS).reduce((n, k) => n + (u[k] ?? 0), 0);
                hit = {
                    mtimeMs: st.mtimeMs,
                    value: {
                        kind: 'agent', id, at: st.mtimeMs, started: u.first, description: a.description, tldr: a.tldr, body: a.body, report: a.report,
                        pr: a.pr, prs: a.prs, branches: [meta.worktreeBranch].filter(Boolean), // transcript gitBranch is the parent checkout's
                        time: u.first != null && u.last > u.first ? formatDuration(u.last - u.first) : null,
                        tokens: tokens ? formatTokens(tokens) : null
                    }
                };
                agentCache.set(path, hit);
            }
            out.push({ ...hit.value, commits: [] });
        } catch {
            continue; // half-written meta or a transcript gone mid-read
        }
    }

    return out;
}

const git = (repo, ...args) => run('git', ['-C', repo, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).then(r => r.stdout);

// The main checkout of the repo a cwd (maybe a worktree) belongs to.
const repoOf = cwd => git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').then(s => dirname(s.trim()));

const gitCache = new Map(); // repo -> { at, pending }
export function commits(repo) {

    let hit = gitCache.get(repo);
    if (!hit || Date.now() - hit.at > GIT_TTL_MS) {
        hit = { at: Date.now(), pending: readCommits(repo) };
        gitCache.set(repo, hit);
    }

    return hit.pending;
}

async function readCommits(repo) {

    const since = '--since=7.days';
    const head = (await git(repo, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).trim().replace(/^[^/]+\//, '');
    const defaultBranch = head || (await git(repo, 'symbolic-ref', '--short', 'HEAD').catch(() => 'main')).trim();
    const [log, local, unpushed, remotes] = await Promise.all([
        git(repo, 'log', '--exclude=refs/stash', '--all', since, '--date-order', '--source', `--format=%H${SEP}%h${SEP}%ct${SEP}%S${SEP}%s`),
        git(repo, 'rev-list', '--branches', '--not', '--remotes', since),
        git(repo, 'rev-list', defaultBranch, '--not', '--remotes', since).catch(() => ''),
        git(repo, 'for-each-ref', '--count=1', 'refs/remotes')
    ]);

    return { defaultBranch, list: markPushed(parseLog(log), local, unpushed, defaultBranch, !!remotes.trim()) };
}

// ---- GET /api/log?project= ----

export async function log(project, now = Date.now()) {

    if (!project) {
        throw Object.assign(new Error('project required'), { status: 400 });
    }

    const since = now - LOG_MS;
    const masters = [];
    for (const dir of await readdir(ROOT)) {
        let files;
        try {
            files = (await readdir(join(ROOT, dir))).filter(f => f.endsWith('.jsonl'));
        } catch {
            continue;
        }
        for (const f of files) {
            const path = join(ROOT, dir, f);
            try {
                const st = await stat(path);
                const cwd = st.mtimeMs >= since && await cwdOf(path);
                if (cwd && await projectOf(cwd) === project) {
                    masters.push({ path, size: st.size, cwd, agentsDir: join(ROOT, dir, f.replace('.jsonl', ''), 'subagents') });
                }
            } catch {
                continue;
            }
        }
    }

    const agents = (await Promise.all(masters.map(m => finishedAgents(m.agentsDir, since)))).flat();
    const chatsOf = await Promise.all(masters.map(m => scanChat(m.path, m.size)));
    const topics = chatsOf.flatMap(c => chatMilestones(c.notes)).filter(t => t.at >= since).map(t => ({ kind: 'topic', ...t }));

    let repo = null, found = { defaultBranch: null, list: [] }, error = null;
    for (const m of masters) {
        repo = await repoOf(m.cwd).catch(() => null);
        if (repo) {
            break;
        }
    }
    if (repo) {
        try {
            found = await commits(repo);
        } catch (e) {
            error = `git log failed: ${String(e.message).split('\n')[0]}`;
        }
    }
    const loose = nestCommits(agents, found.list).map(c => ({ kind: 'commit', ...c }));

    // MRs the chats linked or the agents opened; one an agent opened shows as that agent's chip instead
    const links = new Map(chatsOf.flatMap(c => [...c.links]));
    agents.forEach(a => a.prs.forEach(u => links.set(u, Math.max(links.get(u) ?? 0, a.at))));
    const states = new Map(await Promise.all([...links.keys()].map(async u => [u, await prState(u).catch(() => null)])));
    const byAgent = new Set(agents.flatMap(a => a.prs));
    const mrs = [...links].filter(([u, at]) => at >= since && !byAgent.has(u) && ['merged', 'closed'].includes(states.get(u)?.state))
        // ponytail: the MR payload has no merged_at here, so it sits at the last time a chat linked it
        .map(([url, at]) => ({ kind: 'mr', at, url, state: states.get(url).state, title: states.get(url).title }));
    for (const a of agents) {
        a.prState = a.pr ? states.get(a.pr) ?? null : null;
        delete a.prs;
        delete a.report;
    }

    return { project, repo, defaultBranch: found.defaultBranch, error, days: groupByDay([...agents, ...loose, ...topics, ...mrs], now) };
}
