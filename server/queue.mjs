// The merge queue: GitLab MRs the user queued with Merge. Works one MR per project and target branch at a time (a
// fast-forward project's every merge puts the others behind again): rebase the head through GitLab if it is behind, wait for
// its pipeline and mergeability, merge it, move on. Polled on the board's own poll, from the forge's settled answers.
// Kept in items.json with each MR (store.mjs: `queued`), so a restart goes on where it was.
import { rebaseMr, mergeMr } from './forge.mjs';

export const mergeQueue = new Map(); // MR url -> { at, project, target, step }
export const queueStops = new Map(); // MR url -> { reason, sha }: why it left the queue, shown on its row while its head is unchanged
const busy = new Set(); // MR urls with a rebase or merge in flight

export const isGitLabMr = url => /\/-\/merge_requests\/\d+$/.test(url ?? '');

/** What the head of a line does next, from its settled forge state: { do: 'done' | 'stop' | 'rebase' | 'merge' | 'wait', why }. */
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
    if (ps.blocked === 'conflict') {
        return stop('it has merge conflicts');
    }
    if (ps.ci === 'failing') {
        return stop('its pipeline failed');
    }
    if (ps.changes || ps.mergeStatus === 'discussions_not_resolved') {
        return stop('it has unresolved discussions');
    }
    if (ps.reviewRequired && !ps.approved) {
        return stop('it needs approval');
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
 * One pass over the board's rows ({ pr, project, prState }): drops merged and closed MRs and starts the next step of each
 * line's head. A rebase or merge runs on in the background; onChange says when one ended. Never throws.
 */
export function advanceQueue(items, onChange = () => {}, { rebase = rebaseMr, merge = mergeMr, queue = mergeQueue, stops = queueStops } = {}) {

    const states = new Map(items.filter(i => i.pr && i.prState && !i.prState.unread).map(i => [i.pr, i.prState]));
    const leave = (url, reason, sha) => {
        queue.delete(url);
        reason && stops.set(url, { reason, sha });
        onChange();
    };
    const heads = new Map();

    for (const [url, q] of [...queue].sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]))) {
        const ps = states.get(url);
        if (ps?.state === 'merged' || ps?.state === 'closed') {
            leave(url, ps.state === 'closed' ? 'it was closed' : null, ps.sha);
        } else if (ps) {
            const line = `${q.project}\n${q.target}`;
            if (!heads.has(line)) {
                heads.set(line, url);
            }
        }
    }

    for (const url of heads.values()) {
        const q = queue.get(url), ps = states.get(url), step = queueStep(ps);
        if (!q || !ps || busy.has(url)) {
            continue;
        }
        q.step = step.why;
        if (step.do === 'stop') {
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
    }
}

/** Fills the queue from the store's entries ({ queued: { at, target } }) after a start. */
export function restoreQueue(store, queue = mergeQueue) {

    for (const [project, urls] of Object.entries(store.data)) {
        for (const [url, e] of Object.entries(urls)) {
            if (e.queued && isGitLabMr(url) && e.state === 'open') {
                queue.set(url, { at: e.queued.at, project, target: e.queued.target, step: null });
            }
        }
    }
}
