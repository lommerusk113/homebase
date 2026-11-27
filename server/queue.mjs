// The merge queue: GitLab MRs the user queued with Merge. Works one MR per project and target branch at a time (a
// fast-forward project's every merge puts the others behind again): rebase the head through GitLab if it is behind, wait for
// its pipeline and mergeability, merge it, move on. Polled on the board's own poll, from the forge's settled answers.
// Kept in items.json with each MR (store.mjs: `queued`), so a restart goes on where it was.
import { rebaseMr, mergeMr } from './forge.mjs';

export const FIX_GRACE_MS = 2 * 60_000; // the helper is given this long to start on its fix
export const FIX_SETTLE_MS = 90_000; // idle this long with the MR still broken: its fix failed (a push needs a forge lookup to show)
export const FIX_MAX_MS = 6 * 3600_000;
export const FIX_MAX_EPISODES = 3; // fix helpers started for one MR while it stays queued

export const mergeQueue = new Map(); // MR url -> { at, project, target, step, fix?: { kind, at, sha, idleSince, helper }, fixes? }
export const queueStops = new Map(); // MR url -> { reason, sha }: why it left the queue, shown on its row while its head is unchanged
const busy = new Set(); // MR urls with a rebase or merge in flight

export const isGitLabMr = url => /\/-\/merge_requests\/\d+$/.test(url ?? '');

/** What the head of a line does next, from its settled forge state: { do: 'done' | 'stop' | 'fix' | 'rebase' | 'merge' | 'wait', why }. A conflict or failed pipeline is 'fix' (kind): a helper is started to fix it. */
export function queueStep(ps) {

    const stop = why => ({ do: 'stop', why });

    if (ps.state === 'merged') {
        return { do: 'done' };
    }
    if (ps.state === 'closed') {
        return stop('it was closed');
    }
    if (ps.draft) {
        return stop('it is a draft');
    }
    if (ps.changes || ps.mergeStatus === 'discussions_not_resolved') {
        return stop('it has unresolved discussions');
    }
    if (ps.reviewRequired && !ps.approved) {
        return stop('it needs approval');
    }
    // only a conflict or a failed pipeline can be fixed by its chat; one that also needs approval or threads would only wait again
    if (ps.blocked === 'conflict') {
        return { do: 'fix', kind: 'conflict', why: 'it has merge conflicts' };
    }
    if (ps.ci === 'failing') {
        return { do: 'fix', kind: 'pipeline', why: 'its pipeline failed' };
    }
    if (ps.blocked === 'rebase') {
        return { do: 'rebase', why: 'rebasing on GitLab' };
    }
    if (ps.ready) {
        return { do: 'merge', why: 'merging' };
    }

    return { do: 'wait', why: ps.ci === 'running' ? 'waiting for its pipeline' : 'waiting for GitLab to say it can merge' };
}

/** Where an MR stands in its line: { n: 1-based place, of: length }, or null when not queued. */
export function placeOf(url, queue = mergeQueue) {

    const mine = queue.get(url);
    if (!mine) {
        return null;
    }
    const line = [...queue].filter(([, q]) => q.project === mine.project && q.target === mine.target).sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]));

    return { n: line.findIndex(([u]) => u === url) + 1, of: line.length };
}

/**
 * One pass over the board's rows ({ pr, project, prState, sessionId, fix }): drops merged and closed MRs and starts the next step of
 * each line's head. A head with a conflict or failed pipeline is not dropped: `start(row, action)` (startActionHelper) starts the
 * row's Rebase or Fix-pipeline helper, or hands back the one already running, and the MR waits in the queue ("waiting for its
 * helper to fix it") while the next MR of the line goes; clean again, it takes its turn. It leaves, with the reason, when the
 * helper can't be started, the helper goes idle with the MR still broken, or after FIX_MAX_MS. A rebase or merge runs on in the background; onChange says when one ended. Never throws.
 */
export function advanceQueue(items, onChange = () => {}, { rebase = rebaseMr, merge = mergeMr, queue = mergeQueue, stops = queueStops, start = async () => { throw new Error('no helper starter'); }, chat = () => null, now = Date.now() } = {}) {

    const rows = new Map(items.filter(i => i.pr && i.prState && !i.prState.unread).map(i => [i.pr, i]));
    const states = new Map([...rows].map(([url, i]) => [url, i.prState]));
    const leave = (url, reason, sha) => {
        queue.delete(url);
        reason && stops.set(url, { reason, sha });
        onChange();
    };
    const order = [...queue].sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]));

    for (const [url, q] of order) {
        const ps = states.get(url);
        if (ps?.state === 'merged' || ps?.state === 'closed') {
            leave(url, ps.state === 'closed' ? 'it was closed' : null, ps.sha);
        }
    }

    // an MR whose chat is fixing it: stays queued, moves on or drops by what the forge shows now
    for (const [url, q] of order) {
        const ps = states.get(url);
        if (!q.fix || !queue.has(url) || !ps) {
            continue;
        }
        const step = queueStep(ps), fix = q.fix;
        if (step.do === 'stop') {
            leave(url, step.why, ps.sha);
        } else if (step.do !== 'fix') { // clean again: back in its place in the line
            delete q.fix;
            onChange();
        } else if (step.kind !== fix.kind) { // the fix worked, something else broke: asked again below
            delete q.fix;
        } else if (now - fix.at >= FIX_MAX_MS) {
            leave(url, `its helper did not fix it in ${FIX_MAX_MS / 3600_000} hours`, ps.sha);
        } else {
            fix.idleSince = !fix.helper || chat(fix.helper)?.status === 'working' ? null : fix.idleSince ?? now; // no helper id yet: still starting
            if (fix.idleSince != null && now - fix.idleSince >= FIX_SETTLE_MS && now - fix.at >= FIX_GRACE_MS) {
                leave(url, `its helper could not fix ${fix.kind === 'conflict' ? 'the merge conflicts' : 'the pipeline'}`, ps.sha);
            } else {
                q.step = `waiting for its helper to fix ${fix.kind === 'conflict' ? 'the conflict' : 'the pipeline'}`;
            }
        }
    }

    // each line's first MR not being fixed; one that needs a fix hands it to a helper and the next of the line goes meanwhile
    const lines = new Map();
    for (const [url, q] of order) {
        if (queue.has(url) && states.has(url) && !q.fix) {
            const line = `${q.project}\n${q.target}`;
            lines.set(line, [...lines.get(line) ?? [], url]);
        }
    }

    for (const urls of lines.values()) {
        for (const url of urls) {
            const q = queue.get(url), ps = states.get(url), step = queueStep(ps);
            if (!q || !ps || busy.has(url)) {
                break;
            }
            q.step = step.why;
            if (step.do === 'fix') {
                askHelper(url, q, ps, step, rows.get(url));
                if (queue.has(url)) { // handed to its helper: the line goes on
                    continue;
                }
            } else if (step.do === 'stop') {
                leave(url, step.why, ps.sha);
            } else if (step.do === 'rebase' || step.do === 'merge') {
                busy.add(url);
                (step.do === 'rebase' ? rebase(url) : merge(url, ps.sha))
                    .then(() => step.do === 'merge' && queue.delete(url), e => leave(url, e.message.replace(/^Couldn't (rebase|merge): /, ''), ps.sha))
                    .catch(() => {})
                    .finally(() => {
                        busy.delete(url);
                        onChange();
                    });
            }
            break;
        }
    }

    // Starts (or reuses) the row's fix helper; over the episode cap, or when no helper can be started, the MR leaves with the reason.
    function askHelper(url, q, ps, step, row) {

        if (!row || (q.fixes ?? 0) >= FIX_MAX_EPISODES) {
            return leave(url, step.why, ps.sha);
        }
        const fix = { kind: step.kind, at: now, sha: ps.sha, idleSince: null, helper: null };
        q.fix = fix;
        q.fixes = (q.fixes ?? 0) + 1;
        q.step = `waiting for its helper to fix ${step.kind === 'conflict' ? 'the conflict' : 'the pipeline'}`;
        onChange();
        start(row, step.kind === 'conflict' ? 'conflict' : 'failing').then(r => {
            fix.helper = r.helper.id;
            onChange();
        }, e => {
            console.error(`merge queue: could not start a helper to fix ${url}: ${e.message}`);
            leave(url, `${step.why} and its helper could not be started (${e.message})`, ps.sha);
        });
    }
}

/** Fills the queue from the store's entries ({ queued: { at, target } }) after a start. */
export function restoreQueue(store, queue = mergeQueue) {

    for (const [project, urls] of Object.entries(store.data)) {
        for (const [url, e] of Object.entries(urls)) {
            if (e.queued && isGitLabMr(url) && e.state === 'open') {
                queue.set(url, { at: e.queued.at, project, target: e.queued.target, step: null, ...(e.queued.fix && { fix: { ...e.queued.fix, idleSince: null }, fixes: e.queued.fixes ?? 1 }) });
            }
        }
    }
}
