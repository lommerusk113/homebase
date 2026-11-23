// The milestone filter's logic: what the header pill says and which work items it keeps. The pill itself is the Header
// island (web/src/islands/Header/MilestonePill.vue), its polling web/src/composables/useMilestoneFilter.ts.
import { el } from './core.js';

/** @param {string | null | undefined} d a date, "2026-12-01" */
export const due = d => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');

// Whether a work item stays in the list for the selected milestone ({ id } or null): items with an MR of that
// milestone, plus items without an MR (running or stopped agents), with an MR not checked yet (no prState, so its
// milestone is unknown). An MR of another milestone or none is hidden, even when it waits on you. No selection keeps everything.
/** @param {WorkItem} item @param {{ id: number } | null} selected */
export function inMilestone(item, selected) {
    return !selected || !item.pr || !item.prState || item.milestone?.id === selected.id;
}

// Small tag for a work-item row whose MR belongs to a milestone (item.milestone { id, title } comes from the server).
/** @param {WorkItem} item */
export function milestoneTag(item) {
    if (!item?.milestone) {
        return null;
    }
    const t = el('span', 'chip ms-tag', `⚑ ${item.milestone.title}`);
    t.title = `Milestone: ${item.milestone.title}`;
    return t;
}

// Pill text and tooltip for a selected milestone (groups from the server's groupIssues): "11 open", the full breakdown in the tooltip.
// Before the server has the issues (ms.loading, no groups) the counts come from the milestone list.
/** @param {SelectedMilestone} ms @returns {{ text: string, tip: string }} */
export function pillLabel(ms) {

    const g = ms.groups, open = ms.total - ms.closed;
    if (ms.mine) {
        return g ? { text: `${open} open`, tip: `Assigned to you: ${open} open issues across all milestones` } : { text: 'loading…', tip: 'Loading your issues…' };
    }
    if (!g) {
        return { text: ms.total == null ? 'loading…' : `${open} open`, tip: `${ms.title}: loading issues… · ${due(ms.due)}` };
    }
    const parts = [[g.doing, 'in progress'], [g.closable, 'can be closed'], [g.assigned, 'not started'], [g.unassigned, 'unassigned']]
        .filter(([l]) => l.length).map(([l, label]) => `${l.length} ${label}`);

    return { text: `${open} open`, tip: `${ms.title}: ${open} open of ${ms.total}${parts.length ? ` (${parts.join(', ')})` : ''}, ${ms.closed} closed · ${due(ms.due)}` };
}

// An /api/milestones answer (status, body) as the pill's data. A body without a milestone list (a bare 500 from an
// older server, a proxy page) becomes the error state, so the pill never waits on it.
/** @param {number} status @param {string} text @param {string} [project] @returns {Milestones} */
export function toData(status, text, project = '') {
    try {
        const d = JSON.parse(text);
        if (Array.isArray(d?.milestones)) {
            return d;
        }
    } catch {}
    return { project, milestones: [], detected: [], me: null, selected: null, updating: false, loading: false, reason: 'error', error: text.trim() || `HTTP ${status}`, url: null };
}

// Whether to poll fast: the milestone list or the issues still load, or a refresh runs. A reason (none, error, unsupported) is final.
/** @param {Milestones} d */
export const isLoading = d => !d.reason && !!(d.loading || d.selected?.loading || d.updating);

// Pill text and tooltip for a project without milestones to show (data.reason), null otherwise.
/** @param {Milestones} d @returns {{ text: string, tip: string, err: boolean } | null} */
export function emptyPill(d) {
    if (!d.reason) {
        return null;
    }
    if (d.reason === 'none') {
        return { text: 'No milestones', tip: `No open milestones in ${d.project}`, err: false };
    }
    return { text: 'Milestones unavailable', tip: `${d.error ?? d.reason}\nRefresh (r) to retry`, err: true };
}
