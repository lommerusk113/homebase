// Work-item rules (pure): one item per MR or loose agent, its column, lifecycle stage, next step, row action, gate badge and milestone.
import { PR_URL, USAGE_KEYS, formatDuration, formatTokens } from './transcripts.mjs';
import { mentionsMr, mrNumber, mrRef } from './forge.mjs';

const RECENT_DONE_MS = 2 * 3600_000;

export function column(status, prState, hasPr) {

    if (status === 'working') {
        return 'doing';
    }
    if (prState?.state === 'merged' || prState?.state === 'closed') {
        return 'done';
    }
    if (prState?.changes) {
        return 'needs-you';
    }
    if (prState?.ready) {
        return 'ready';
    }
    if (hasPr) {
        return 'review';
    }

    return status === 'waiting' ? 'needs-you' : 'idle';
}

// The newest gate run that names this MR by URL, !N / #N, or its branch.
export function gateFor(runs, url, branch) {

    const ref = new RegExp(`(?<![\\w/])${mrRef(url)}\\b`);

    return runs.filter(r => r.text.includes(url) || ref.test(r.text) || (branch && r.text.includes(branch))).toSorted((a, b) => b.at - a.at)[0] ?? null;
}

// Stale once the MR head moved past the commit the gate checked; without a commit in the report, the head first seen alongside the run stands in.
export function toGate(run, sha, heads = new Map()) {

    if (!run) {
        return null;
    }

    const key = `${run.at}:${run.text.length}`;
    if (sha && !heads.has(key)) {
        heads.set(key, sha); // ponytail: in memory, so a push before a Homebase restart goes unnoticed
    }
    const checked = run.commit ?? heads.get(key);

    return { verdict: run.verdict, at: run.at, tldr: run.tldr, commit: run.commit, stale: !!(sha && checked && !sha.startsWith(checked) && !checked.startsWith(sha)) };
}

// The left side's lifecycle: agent stages first, then MR states.
const LIFECYCLE = ['Implement', 'Verify', 'Review', 'Approved', 'Merged'];
const VERB = ['exploring', 'implementing', 'verifying', 'shipping', 'finishing'];

function lifecycle(pr, prState, agent) {

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

    return !hasPr && agent?.status === 'done' ? 'finished' : column('idle', prState, hasPr);
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
    if (prState.ci === 'failing') {
        return 'Pipeline failing';
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

    const ref = `${mrRef(pr)} (${pr})`;
    if (prState.changes) {
        return { label: 'Fix & reply', message: `Address the review comments on ${ref}, push, and reply in each thread.` };
    }
    if (prState.ci === 'failing') {
        return { label: 'Fix pipeline', message: `The pipeline on ${ref} is failing — find out why and fix it.` };
    }
    if (prState.replied && !prState.ready) {
        return null; // every open thread was last answered by me: the reviewer resolves them, unless GitLab already allows the merge
    }
    if (prState.ready) {
        return { label: 'Merge + close issue', message: `Run review-gate on ${ref}. If the verdict is ready, merge it and close its issue. If it's fix first, show me the findings and don't merge.` };
    }
    if (!prState.reviewers?.length && !prState.draft) {
        return { label: 'Request review', message: `Assign a reviewer to ${ref} — suggest who.` };
    }

    return null;
}

// A report that merely quotes another repo's MR (e.g. a Homebase agent citing a pracsys MR) isn't work on this project.
export function sameRepo(url, project) {
    return url.match(/^https:\/\/[^/]+\/(.+?)(?:\/-)?\/(?:merge_requests|pull)\//)?.[1].split('/').pop() === project;
}

const gateHeads = new Map(); // gate run -> MR head sha first seen with it

// A prompt's first MR URL, first `!N` and first `#N`: what it is about, not the other issues it lists for context.
const leadRefs = text => [PR_URL, /(?<![\w&!#])!\d+/, /(?<![\w&!#])#\d+/].map(re => text.match(re)?.[0]).filter(Boolean).join(' ');

// An agent works on an MR when its description names `!N`, or, while not done, it is on the MR's branch, its
// description names the MR or its issue, its prompt's first MR or issue ref is it, or the master's prompt behind the
// call that started it (`spawnedFor`) names it anywhere, as "merge !1784 and !1785" does both.
export function worksOnMr(agent, url, prState) {

    const n = mrNumber(url);
    if (new RegExp(`!${n}(?!\\d)`).test(agent.description ?? '')) {
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

    // seeded MRs bind to their stored session if it is still around, else the project's most recent one, so the chat and the action buttons work
    const stored = new Map();
    for (const { url, project, sessionId, agents = [] } of seeds) {
        const it = add(url, project);
        const inProject = sessions.filter(s => s.project === project);
        const latest = inProject.toSorted((a, b) => (b.lastActivity ?? b.updated ?? 0) - (a.lastActivity ?? a.updated ?? 0))[0];
        it.linkSession ??= inProject.find(s => s.id === sessionId)?.id ?? latest?.id ?? null;
        stored.set(it, [...stored.get(it) ?? [], ...agents]);
    }

    const loose = [];
    for (const s of sessions) {
        for (const a of s.agents ?? []) {
            const own = { ...a, sessionId: s.id };
            const refs = new Set((a.prs ?? []).filter(u => sameRepo(u, s.project)).map(u => byUrl.get(u)).filter(Boolean));
            for (const it of byUrl.values()) {
                if (it.project === s.project && worksOnMr(a, it.pr, prOf(it.pr))) {
                    refs.add(it);
                }
            }

            if (refs.size) {
                refs.forEach(it => it.agents.push(own));
            } else if (a.status !== 'done' || now - a.updated < RECENT_DONE_MS) { // finished without an MR: shown a while so the user sees it completed
                loose.push({ key: a.id, pr: null, project: s.project, agents: [own], linkedAt: 0, linkSession: null });
            }
        }
    }

    // agents that scrolled out of the transcripts keep their link, unless they are still live
    const live = new Set(sessions.flatMap(s => (s.agents ?? []).map(a => a.id)));
    for (const [it, agents] of stored) {
        for (const a of agents.filter(a => !live.has(a.id))) {
            it.agents.push({ id: a.id, description: a.description, status: 'done', stage: 4, updated: a.finished ?? 0, prs: [it.pr], sessionId: it.linkSession });
        }
    }

    return [...byUrl.values(), ...loose];
}

// Token sums and working time over an item's agents: summed per agent, so idle gaps between agents don't count;
// a running agent counts up to now.
function agentUsage(agents, now) {

    const tokens = Object.fromEntries(Object.keys(USAGE_KEYS).map(k => [k, agents.reduce((n, a) => n + (a.usage?.[k] ?? 0), 0)]));
    const total = Object.values(tokens).reduce((a, b) => a + b, 0);
    const timeMs = agents.reduce((n, a) => n + (a.usage?.first != null ? (a.status === 'running' ? now : a.usage.last) - a.usage.first : 0), 0);

    return {
        tokens: total ? formatTokens(total) : null,
        tokensTitle: total ? `input ${tokens.input.toLocaleString('en')} · output ${tokens.output.toLocaleString('en')} · cache read ${tokens.cacheRead.toLocaleString('en')} · cache write ${tokens.cacheWrite.toLocaleString('en')}` : null,
        time: timeMs > 0 ? formatDuration(timeMs) : null
    };
}

// One row per work item, newest agent first, with its column, stage, next step, action, gate badge and usage.
export function workItems(sessions, prOf = () => null, now = Date.now(), heads = gateHeads, seeds = []) {

    return itemGroups(sessions, prOf, now, seeds).map(it => {

        const agents = it.agents.toSorted((a, b) => b.updated - a.updated);
        const agent = agents[0] ?? null;
        const prState = it.pr ? prOf(it.pr) : null;
        const gates = it.pr ? sessions.filter(s => s.project === it.project).flatMap(s => [...s.gates ?? [], ...(s.agents ?? []).flatMap(a => a.gates ?? [])]) : [];
        const stage = lifecycle(it.pr, prState, agent);
        // asked in the master's open turn but no agent runs for it yet: show it as in progress, without the button
        const requested = it.pr && agent?.status !== 'running' && prState?.state !== 'merged' && prState?.state !== 'closed'
            ? requestFor(sessions, it.project, it.pr, prState) : null;
        const col = requested ? 'doing' : itemColumn(prState, agent, !!it.pr);
        const title = prState?.title ?? agent?.description ?? it.pr;

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
            agentLinks: agents.filter(a => a.status === 'done').map(a => ({ id: a.id, description: a.description, finished: a.updated })), // for the store; dropped before the response
            activity: agents.slice(1).map(a => ({ id: a.id, description: a.description, status: a.status, tldr: a.tldr })),
            requested: requested && { at: requested.at, text: requested.text.slice(0, 200) },
            next: requested ? 'Claude is on it…' : col === 'finished' ? 'Finished without an MR' : nextStep(prState, agent),
            action: requested ? null : rowAction(it.pr, prState, agent, title),
            gate: it.pr ? toGate(gateFor(gates, it.pr, prState?.branch), prState?.sha, heads) : null,
            ...agentUsage(agents, now)
        };
    });
}

const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Milestone { id, title } of an MR: its own milestone, else the listed one whose slug is its target branch (supplier-automation).
export function milestoneOf(prState, list) {

    const m = prState && (prState.milestone ?? list.find(m => slug(m.title) === prState.target));

    return m ? { id: m.id, title: m.title } : null;
}
