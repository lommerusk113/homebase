// Work-item rules (pure): one item per MR or loose agent, its column, lifecycle stage, next step, row action, gate badge and milestone.
import { PR_URL } from './entries.mjs';
import { USAGE_KEYS, IDLE_CUTOFF_MS, formatDuration, formatTokens } from './usage.mjs';
import { mentionsMr, mrRef, forgeWords } from './forge.mjs';
import { canned } from '../web/src/lib/canned.ts';

const RECENT_DONE_MS = 2 * 3600_000;

// The newest gate run that names this MR by URL, !N / #N, or its branch.
export function gateFor(runs, url, branch) {

    const ref = new RegExp(`(?<![\\w/])${mrRef(url)}\\b`);

    return runs.filter(r => r.text.includes(url) || ref.test(r.text) || (branch && r.text.includes(branch))).toSorted((a, b) => b.at - a.at)[0] ?? null;
}

// Stale once the MR head moved past the commit the gate checked; without a commit in the report, the head first seen alongside the run stands in.
// A run older than `since` (the server start) with no remembered head gets none: it counts as stale, never as passed.
export const gateKey = run => `${run.at}:${run.text.length}`;
export function toGate(run, sha, heads = new Map(), since = 0) {

    if (!run) {
        return null;
    }

    const key = gateKey(run);
    if (sha && !heads.has(key) && run.at >= since) {
        heads.set(key, sha); // ponytail: the first poll after the run stands in for the gate's commit; the store (gateHeadsOf) keeps it across restarts
    }
    const checked = run.commit ?? heads.get(key);

    return { verdict: run.verdict, at: run.at, tldr: run.tldr, commit: run.commit, stale: !!(sha && (!checked || (!sha.startsWith(checked) && !checked.startsWith(sha)))) };
}

// A row's stage in LIFECYCLE: agent stages first, then MR states.
const LIFECYCLE = ['Implement', 'Verify', 'Review', 'Approved', 'Merged'];
const VERB = ['exploring', 'implementing', 'verifying', 'shipping', 'finishing'];

function stageOf(pr, prState, agent) {

    if (prState?.state === 'merged' || prState?.state === 'closed') {
        return 4;
    }
    if (prState?.ready || prState?.approved) {
        return 3;
    }

    return pr ? 2 : [0, 0, 1, 2, 2][agent?.stage ?? 0];
}

// Last activity: the newest of the agent's, the link's and the MR's own update (forge-seeded MRs have no agent or link time); 0 when none.
export const itemUpdated = (agent, linkedAt, prState) => Math.max(agent?.updated ?? 0, linkedAt ?? 0, prState?.updatedAt ?? 0);

const BLOCKED_STEP = { conflict: 'Merge conflicts — rebase it', rebase: 'Needs a rebase onto its target', blocked: 'Blocked by another MR', checks: 'Waiting for external status checks' }; // blocked and checks are GitLab's

const clock = ms => (ms ? new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

// The MR's own next step (no agent): review comments, a failing pipeline and conflicts first, then what blocks the merge.
function mrNext(prState, mr) {

    if (!prState) {
        return `Open the ${mr} to check its state`;
    }
    // everything in the way is said, the first thing to do first
    const blockers = [reviewComments(prState), prState.ci === 'failing' && 'Pipeline failing', prState.blocked && BLOCKED_STEP[prState.blocked], prState.notReady].filter(Boolean);
    if (blockers.length) {
        return blockers.join(' · ');
    }
    if (prState.replied && !prState.ready) {
        const n = prState.replied;
        return `Replied to ${n} thread${n === 1 ? '' : 's'} — waiting for ${prState.repliedTo?.join(', ') || 'the reviewer'} to resolve`;
    }
    if (prState.ci === 'running') {
        return 'Pipeline running';
    }
    if (prState.draft) {
        return 'Draft — mark it ready for review';
    }
    if (prState.ready) {
        const n = prState.replied;
        return `Approved — merge it${n ? ` · ${n} replied thread${n === 1 ? '' : 's'} still open` : ''}`;
    }

    return prState.reviewers?.length ? `Waiting for review by ${prState.reviewers.join(', ')}` : 'Needs a reviewer';
}

const GATE_STEP = 'Gate not passed for the latest commit — run review-gate';

// An approved MR is only ready to merge once the gate passed for its head and no thread is open; otherwise it stays in review with the first blocker named.
function demote(prState, gate) {

    if (!prState?.ready) {
        return prState;
    }
    const notReady = gate?.verdict !== 'ready' || gate.stale ? GATE_STEP
        : prState.replied ? `${prState.replied} thread${prState.replied === 1 ? '' : 's'} still open — resolve them` : null;

    return notReady ? { ...prState, ready: false, approved: true, notReady } : prState;
}

// The step review comments ask for, or null when there are none.
function reviewComments(prState) {

    if (prState.unresolved || prState.unanswered) {
        const u = prState.unresolved ?? 0, g = prState.unanswered ?? 0;
        const by = [...new Set([...prState.unresolvedBy ?? [], ...prState.unansweredBy ?? []])];
        const from = by.length ? ` from ${by.join(', ')}` : '';
        const comments = n => `comment${n === 1 ? '' : 's'}`;

        if (prState.ready) {
            return `Approved — ${u + g} unanswered ${comments(u + g)}${from}`;
        }
        if (!g) {
            return `Address ${u} unresolved ${comments(u)}${from}`;
        }
        if (!u) {
            return g === 1 && by.length ? `Reply to ${by[0]}'s comment` : `Answer ${g} ${comments(g)}${from}`;
        }

        return `Address ${u} unresolved thread${u === 1 ? '' : 's'} and answer ${g} ${comments(g)}${from}`;
    }
    if (prState.changes) {
        const by = prState.changesBy?.length ? prState.changesBy : prState.reviewers ?? [];
        return by.length ? `Address review comments from ${by.join(', ')}` : 'Address review comments';
    }

    return null;
}

// One kind per row, from the same inputs the old chains read; KINDS says what each kind shows. ps: the MR state after demote().
// Order matters: an MR's first blocker wins, as in rowAction.
export function deriveKind(ps, agent, hasPr, requested = false) {

    if (ps?.state === 'merged') {
        return { kind: 'merged', reason: 'the forge says merged' };
    }
    if (ps?.state === 'closed') {
        return { kind: 'abandoned', reason: 'the forge says closed' };
    }
    if (requested) {
        return { kind: 'requested', reason: 'named in an open prompt' };
    }
    if (agent?.status === 'running') {
        return { kind: 'running', reason: 'the helper is working' };
    }
    if (agent?.status === 'stopped') {
        return { kind: STOPPED.has(agent.stopReason) ? agent.stopReason : 'stopped', reason: agent.stopReason ?? 'no reason given' };
    }
    if (!hasPr && agent?.status === 'done') {
        return { kind: 'finished', reason: 'the helper finished without an MR' };
    }
    if (!ps) {
        return hasPr ? { kind: 'unknown', reason: 'no answer from the forge' } : { kind: 'idle', reason: 'nothing to do' };
    }

    // review comments ask for a fix with or without the forge's changes flag; on an approved MR they are a note on Approved
    const kind = ps.changes || (!ps.ready && (ps.unresolved || ps.unanswered)) ? 'changes'
        : ps.ci === 'failing' ? 'failing'
        : ps.blocked === 'conflict' || ps.blocked === 'rebase' ? 'conflict'
        : ps.blocked ? 'blocked'
        : ps.draft && ps.ci !== 'running' ? 'draft' // nothing blocks it but the draft flag: the user takes it out of draft
        : ps.notReady === GATE_STEP ? 'gate'
        : ps.notReady ? 'threads'
        : ps.replied && !ps.ready ? 'replied'
        : ps.ci === 'running' ? 'pipeline'
        : ps.ready ? 'ready'
        : ps.reviewers?.length ? 'in-review' : 'needs-reviewer';

    return { kind, reason: 'the MR state' };
}

const STOPPED = new Set(['api-error', 'rate-limit', 'interrupted', 'closed', 'silent']);

const mrRefOf = c => `${mrRef(c.pr)} (${c.pr})`;
const continueIt = c => canned('continue', c.title);
const stoppedText = why => c => {
    const at = clock(c.agent.updated);
    return `Helper stopped: ${why}${at ? ` at ${at}` : ''} — Continue resumes it`;
};
// A guess, not a signal: the helper may still be working.
const silentText = c => {
    const m = c.agent.updated ? Math.max(1, Math.round((c.now - c.agent.updated) / 60_000)) : null;
    return m ? `No output for ${m}m — may still be working · Continue nudges it` : 'No recent output — may still be working · Continue nudges it';
};
const baseStage = c => stageOf(c.pr, c.ps, c.agent);
const noButton = () => null;
const mrKind = (column, action = noButton) => ({ column, action: c => (c.pr ? action(c) : null), next: c => mrNext(c.ps, c.mr), stage: baseStage });
const agentKind = (column, next, action = noButton) => ({ column, next, action, stage: baseStage });

// What each kind of row shows: column (its group; see columnOf), next (its text), action (the canned send of its button, or null)
// and stage (its lifecycle index). c: { ps, agent, pr, title, mr, aMr, now, error }, error being why the forge couldn't be asked.
export const KINDS = {
    merged: { column: 'done', next: () => 'Merged', action: noButton, stage: () => 4 },
    abandoned: { column: 'closed', next: () => 'Closed without merging', action: noButton, stage: () => 4 },
    requested: agentKind('doing', () => 'Sent to Claude…'),
    running: agentKind('doing', c => c.agent.step ?? `${c.agent.description} is ${VERB[c.agent.stage] ?? 'working'}…`),
    stopped: agentKind('needs-you', () => 'Agent stopped — check the chat', continueIt),
    'api-error': agentKind('needs-you', stoppedText('API error'), continueIt),
    'rate-limit': agentKind('needs-you', stoppedText('rate limit hit'), continueIt),
    interrupted: agentKind('needs-you', stoppedText('interrupted'), continueIt),
    closed: agentKind('needs-you', () => 'Helper stopped: its chat was closed — Continue resumes it', continueIt),
    silent: agentKind('needs-you', silentText, continueIt),
    finished: agentKind('finished', c => `Finished without ${c.aMr}`),
    idle: mrKind('idle'),
    unknown: { ...mrKind('unknown'), next: c => (c.error ? `Couldn't check the ${c.mr}: ${c.error}` : mrNext(null, c.mr)) },
    changes: mrKind('needs-you', c => canned('fix', mrRefOf(c))),
    failing: mrKind('needs-you', c => canned('pipeline', mrRefOf(c))),
    conflict: mrKind('needs-you', c => canned('rebase', mrRefOf(c))),
    blocked: mrKind('review'),
    gate: { ...mrKind('review', c => canned('gate', mrRefOf(c))), stage: () => 2 }, // approved but not through the gate: still in review
    threads: mrKind('review'),
    replied: mrKind('review'),
    pipeline: mrKind('review'),
    draft: { ...mrKind('needs-you', c => canned('ready', mrRefOf(c))), next: () => 'Ready except draft: mark ready' },
    ready: mrKind('ready', c => canned('merge', mrRefOf(c))),
    'in-review': mrKind('review'),
    'needs-reviewer': mrKind('review', c => canned('review', mrRefOf(c)))
};

// The group of a row. A draft MR that isn't running its pipeline and has no other blocker is kind 'draft' (see deriveKind), so it waits on you.
export const columnOf = kind => KINDS[kind].column;

// A row's column, next text, action and stage from its kind. A finished helper's outcome follows the reason in the text of an MR row.
export function rowOf(ps, agent, { pr = null, title = null, mr = 'MR', aMr = 'a MR', requested = false, now = Date.now(), error = null } = {}) {

    const { kind, reason } = deriveKind(ps, agent, !!pr, requested);
    const k = KINDS[kind];
    const c = { ps, agent, pr, title, mr, aMr, now, error };
    let next = k.next(c);
    if (agent?.status === 'done' && agent.outcome && agent.stopReason !== 'killed' && k.column !== 'finished' && !['merged', 'abandoned', 'requested'].includes(kind)) {
        const at = clock(agent.updated);
        // the reason leads, so a truncated line still says why the row needs you
        const outcome = `Helper finished: ${agent.outcome.replace(/[.!]$/, '')}${at ? ` (${at})` : ''}`;
        next = kind === 'unknown' ? outcome : `${next} · ${outcome}`;
    }

    return { state: { kind, reason }, column: columnOf(kind), next, action: k.action(c), stage: k.stage(c) };
}

// Review chats (server/reviewer.mjs keeps them on disk): row key -> { id, at, sent, sha, rounds }.
export const reviewers = new Map();
export const REVIEWER_START_MS = 2 * 60_000; // a reviewer whose transcript never shows up within this is given up on

// The Review button of an "In review" row, by its reviewer chat: none (or its findings already sent) -> Review, running -> Reviewing…,
// idle with a reply -> Send findings, typing the reviewer's last message into the row's working chat. `session` is the reviewer's, or undefined.
export function reviewAction(r, session, now = Date.now(), sha = null) {

    if (r && (r.sent || (!session && now - r.at > REVIEWER_START_MS))) {
        // Review again only on a moved MR head and under the cap; otherwise no button, and a note once capped
        if (r.rounds >= MAX_REVIEWS) {
            return { note: 'Reviewed twice' };
        }
        if (sha && r.sha && (sha.startsWith(r.sha) || r.sha.startsWith(sha))) {
            return null;
        }
    }
    if (!r || r.sent || (!session && now - r.at > REVIEWER_START_MS)) {
        return { label: 'Review', kind: 'review', message: 'Start a read-only reviewer chat on this branch' };
    }
    if (!session || session.status === 'working' || session.asking || !session.lastReply) {
        return { label: 'Reviewing…', kind: 'reviewing', message: 'The reviewer is working', reviewerId: r.id };
    }

    return {
        label: 'Send findings',
        kind: 'findings',
        message: `Review findings from a fresh reviewer:\n\n${session.lastReply.slice(0, MAX_FINDINGS)}\n\nAddress them.`,
        hint: "Types the reviewer's final message into this chat",
        reviewerId: r.id
    };
}
const MAX_REVIEWS = 2;
const MAX_FINDINGS = 15_000; // a send is capped at 20 KB

// A report that merely quotes another repo's MR (e.g. a Homebase agent citing a pracsys MR) isn't work on this project.
// A pr-link's own prRepository ("owner/name"), when it has one, says which repo it is for better than the URL does.
export function sameRepo(url, project, repo) {
    return (repo ?? url.match(/^https:\/\/[^/]+\/(.+?)(?:\/-)?\/(?:merge_requests|pull)\//)?.[1])?.split('/').pop() === project;
}

const gateHeads = new Map(); // gate run -> MR head sha first seen with it (sessions.mjs passes the stored one instead)
const STARTED = Date.now();

// A prompt's first MR URL, first `!N` and first `#N`: what it is about, not the other issues it lists for context.
const leadRefs = text => [PR_URL, /(?<![\w&!#])!\d+/, /(?<![\w&!#])#\d+/].map(re => text.match(re)?.[0]).filter(Boolean).join(' ');

// An agent works on an MR when its description names `!N` (`#N` on GitHub), or, while not done, it is on the MR's branch, its
// description names the MR or its issue, its prompt's first MR or issue ref is it, or the master's prompt behind the
// call that started it (`spawnedFor`) names it anywhere, as "merge !1784 and !1785" does both.
export function worksOnMr(agent, url, prState) {

    if (new RegExp(`(?<![\\w&!#])${mrRef(url)}(?!\\d)`).test(agent.description ?? '')) {
        return true;
    }
    if (agent.status === 'done') {
        return false;
    }

    return (!!prState?.branch && (agent.branches ?? [agent.branch]).includes(prState.branch))
        || mentionsMr(`${agent.description ?? ''} ${leadRefs(agent.prompt ?? '')}\n${agent.spawnedFor ?? ''}`, url, prState?.issue);
}

// The newest human prompt of an open turn in a session of the project that names the MR, as { at, text }, else null.
export function requestFor(sessions, project, url, prState) {

    const hits = sessions.filter(s => s.project === project).flatMap(s => s.openPrompts ?? []).filter(p => mentionsMr(p.text, url, prState?.issue));

    return hits.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;
}

// The work items' raw groups: one per PR/MR (deduped across sessions and agents), plus running or stopped agents with
// no MR yet. Agents whose description names a known MR (!123) count as work on it; finished agents without an MR stay
// for RECENT_DONE_MS, then drop out. `seeds` are { url, project, sessionId?, agents? } MRs no transcript need mention:
// the user's open MRs from the forge and the stored ones, with their stored finished agents.
function itemGroups(sessions, prOf, now, seeds) {

    const byUrl = new Map();
    const add = (url, project) => {
        if (!byUrl.has(url)) {
            byUrl.set(url, { key: url, pr: url, project, agents: [], linkedAt: 0, linkSession: null });
        }

        return byUrl.get(url);
    };

    for (const s of sessions) {
        for (const { url, at } of (s.prs ?? []).filter(p => sameRepo(p.url, s.project, p.repo))) {
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

    // seeded MRs bind to their stored session if it is still around, else the project's most recent one, so the chat and the action buttons work
    const stored = new Map();
    for (const { url, project, sessionId, agents = [] } of seeds) {
        const it = add(url, project);
        const inProject = sessions.filter(s => s.project === project);
        const latest = inProject.toSorted((a, b) => (b.lastActivity ?? b.updated ?? 0) - (a.lastActivity ?? a.updated ?? 0))[0];
        it.linkSession ??= inProject.find(s => s.id === sessionId)?.id ?? latest?.id ?? null;
        stored.set(it, [...stored.get(it) ?? [], ...agents]);
    }

    // a stopped agent the master retried (a later agent with the same description) is history, not work to continue
    const retried = (a, list) => a.status === 'stopped' && list.some(b => b !== a && b.description === a.description && b.updated > a.updated);

    const loose = [];
    for (const s of sessions) {
        for (const a of (s.agents ?? []).filter((a, _, list) => !retried(a, list))) {
            const own = { ...a, sessionId: s.id };
            const refs = new Set((a.prs ?? []).filter(u => sameRepo(u, s.project)).map(u => byUrl.get(u)).filter(Boolean));
            for (const it of byUrl.values()) {
                if (it.project === s.project && worksOnMr(a, it.pr, prOf(it.pr))) {
                    refs.add(it);
                }
            }

            if (refs.size) {
                refs.forEach(it => it.agents.push(own));
            } else if (a.stopReason === 'killed') {
                continue; // the chat stopped it on purpose: no row, nothing to see or continue
            } else if (a.status !== 'done' || now - a.updated < RECENT_DONE_MS) { // finished without an MR: shown a while so the user sees it completed
                loose.push({ key: a.id, pr: null, project: s.project, agents: [own], linkedAt: 0, linkSession: null });
            }
        }
    }

    // agents that scrolled out of the transcripts keep their link, unless they are still live
    const live = new Set(sessions.flatMap(s => (s.agents ?? []).map(a => a.id)));
    for (const [it, agents] of stored) {
        for (const a of agents.filter(a => !live.has(a.id))) {
            it.agents.push({ id: a.id, description: a.description, status: 'done', stage: 4, updated: a.finished ?? 0, prs: [it.pr], sessionId: it.linkSession, stored: true });
        }
    }

    return [...byUrl.values(), ...loose];
}

// Token sums and working time over an item's agents: summed per agent, so idle gaps between agents don't count;
// a running agent counts up to now only while its last entry is recent. Idle gaps inside a transcript don't count.
function agentUsage(agents, now) {

    const tokens = Object.fromEntries(Object.keys(USAGE_KEYS).map(k => [k, agents.reduce((n, a) => n + (a.usage?.[k] ?? 0), 0)]));
    const total = Object.values(tokens).reduce((a, b) => a + b, 0);
    const timeMs = agents.reduce((n, a) => n + ((a.usage?.active ?? 0) + (a.status === 'running' && a.usage?.last != null && now - a.usage.last < IDLE_CUTOFF_MS ? now - a.usage.last : 0)), 0);

    return {
        tokens: total ? formatTokens(total) : null,
        tokensTitle: total ? `input ${tokens.input.toLocaleString('en')} · output ${tokens.output.toLocaleString('en')} · cache read ${tokens.cacheRead.toLocaleString('en')} · cache write ${tokens.cacheWrite.toLocaleString('en')}` : null,
        time: timeMs > 0 ? formatDuration(timeMs) : null
    };
}

// Rows the user dismissed (server/dismissed.mjs keeps them on disk): item key -> when.
export const dismissed = new Map();
// A dismissed row stays away until its helper moves again (a new message resumed it); then it is back for good.
function isDismissed(x) {

    const at = dismissed.get(x.key);
    if (at == null || x.pr) {
        return false;
    }
    if (x.agentStatus === 'running' || x.updated > at) {
        dismissed.delete(x.key);
        return false;
    }

    return true;
}

// One row per work item, newest agent first, with its column, stage, next step, action, gate badge and usage.
// Without the rows the user dismissed.
export function workItems(sessions, prOf = () => null, now = Date.now(), heads = gateHeads, seeds = [], reviews = reviewers, errorOf = () => null) {

    // a reviewer chat is not work on the MR it reviews: it never becomes a row or its working chat
    const reviewerIds = new Set([...reviews.values()].map(r => r.id));

    return itemGroups(sessions.filter(s => !reviewerIds.has(s.id)), prOf, now, seeds).map(it => {

        const agents = it.agents.toSorted((a, b) => b.updated - a.updated);
        const agent = agents[0] ?? null;
        const prState = it.pr ? prOf(it.pr) : null;
        const gates = it.pr ? sessions.filter(s => s.project === it.project).flatMap(s => [...s.gates ?? [], ...(s.agents ?? []).flatMap(a => a.gates ?? [])]) : [];
        const run = it.pr ? gateFor(gates, it.pr, prState?.branch) : null;
        const gate = it.pr ? toGate(run, prState?.sha, heads, STARTED) : null;
        const ps = demote(prState, gate);
        // asked in the master's open turn but no agent runs for it yet: show it as in progress, without the button
        const requested = it.pr && agent?.status !== 'running' && prState?.state !== 'merged' && prState?.state !== 'closed'
            ? requestFor(sessions, it.project, it.pr, prState) : null;
        const title = prState?.title ?? agent?.description ?? it.pr;
        const w = forgeWords(it.project, it.pr);
        const row = rowOf(ps, agent, { pr: it.pr, title, mr: w.mr, aMr: w.aMr, requested: !!requested, now, error: it.pr ? errorOf(it.pr, it.project) : null });

        const rev = !row.action && row.column === 'review' ? reviewAction(reviews.get(it.key), sessions.find(s => s.id === reviews.get(it.key)?.id), now, prState?.sha) : null;

        return {
            key: it.key,
            project: it.project,
            sessionId: agent?.sessionId ?? it.linkSession,
            title,
            firstTitle: prState?.title ? null : agent?.firstDescription ?? null,
            pr: it.pr,
            prState,
            state: row.state,
            column: row.column,
            stage: row.stage,
            stageLabel: prState?.state === 'closed' ? 'Closed' : LIFECYCLE[row.stage],
            agentStatus: agent?.status ?? null,
            agentId: agent && !agent.stored ? agent.id : null, // "Step in" opens its transcript; one that scrolled out of every tail has none
            agentDescription: agent?.description ?? null,
            updated: itemUpdated(agent, it.linkedAt, prState),
            branch: [prState?.branch, agent?.branch].find(b => b && b !== 'HEAD') ?? null, // transcript gitBranch is unreliable inside worktrees; HEAD is a detached checkout
            stepAt: agent?.status === 'running' ? agent.stepAt ?? null : null,
            worktreePath: agent?.worktreePath ?? null,
            tldr: agent?.tldr ?? null,
            body: agent?.body ?? '',
            files: agent?.files ?? [],
            gateHead: run && heads.get(gateKey(run)) ? [gateKey(run), heads.get(gateKey(run))] : null, // for the store; dropped before the response
            agentLinks: agents.filter(a => a.status === 'done').map(a => ({ id: a.id, description: a.description, finished: a.updated })), // for the store; dropped before the response
            activity: agents.slice(1).map(a => ({ id: a.id, description: a.description, status: a.status, tldr: a.tldr })),
            requested: requested && { at: requested.at, text: requested.text.slice(0, 200) },
            next: row.next,
            action: row.action ?? (rev?.label ? rev : null),
            note: row.action ? null : rev?.note ?? null,
            checks: sessions.find(s => s.id === (agent?.sessionId ?? it.linkSession))?.checks ?? null,
            gate,
            ...agentUsage(agents, now)
        };
    }).filter(x => !isDismissed(x));
}

export const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Milestone { id, title } of an MR: its own milestone, else the listed one whose slug is its target branch (supplier-automation).
export function milestoneOf(prState, list) {

    const m = prState && (prState.milestone ?? list.find(m => slug(m.title) === prState.target));

    return m ? { id: m.id, title: m.title } : null;
}
