// The milestone filter's logic: what the header pill says and which work items it keeps.

/** "due 1 Dec 2026" for a date like "2026-12-01". */
export const due = (d: string | null | undefined): string => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');

// Whether a work item stays in the list for the selected milestone ({ id } or null): items with an MR of that
// milestone, plus items without an MR (running or stopped agents), with an MR not checked yet (no prState, so its
// milestone is unknown). An MR of another milestone or none is hidden, even when it waits on you. No selection keeps everything.
export function inMilestone(item: WorkItem, selected: { id: number } | null): boolean {
    return !selected || !item.pr || !item.prState || item.milestone?.id === selected.id;
}

// Pill text and tooltip for a selected milestone (groups from the server's groupIssues): "11 open", the full breakdown in the tooltip.
// Before the server has the issues (ms.loading, no groups) the counts come from the milestone list.
export function pillLabel(ms: SelectedMilestone): { text: string, tip: string } {

    const g = ms.groups, open = (ms.total ?? 0) - ms.closed;
    if (ms.mine) {
        return g ? { text: `${open} open`, tip: `Assigned to you: ${open} open issues across all milestones` } : { text: 'loading…', tip: 'Loading your issues…' };
    }
    if (!g) {
        return { text: ms.total == null ? 'loading…' : `${open} open`, tip: `${ms.title}: loading issues… · ${due(ms.due)}` };
    }
    const parts = ([[g.doing, 'in progress'], [g.closable, 'can be closed'], [g.assigned, 'not started'], [g.unassigned, 'unassigned']] as const)
        .filter(([l]) => l.length).map(([l, label]) => `${l.length} ${label}`);

    return { text: `${open} open`, tip: `${ms.title}: ${open} open of ${ms.total}${parts.length ? ` (${parts.join(', ')})` : ''}, ${ms.closed} closed · ${due(ms.due)}` };
}

// An /api/milestones answer (status, body) as the pill's data. A body without a milestone list (a bare 500 from an
// older server, a proxy page) becomes the error state, so the pill never waits on it.
export function toData(status: number, text: string, project = ''): Milestones {
    try {
        const d = JSON.parse(text);
        if (Array.isArray(d?.milestones)) {
            return d;
        }
    } catch {}

    return { project, milestones: [], detected: [], me: null, selected: null, updating: false, loading: false, reason: 'error', error: text.trim() || `HTTP ${status}`, url: null };
}

/** Whether to poll fast: the milestone list or the issues still load, or a refresh runs. A reason (none, error, unsupported) is final. */
export const isLoading = (d: Milestones): boolean => !d.reason && !!(d.loading || d.selected?.loading || d.updating);

/** Pill text and tooltip for a project without milestones to show (data.reason), null otherwise. */
export function emptyPill(d: Milestones): { text: string, tip: string, err: boolean } | null {
    if (!d.reason) {
        return null;
    }
    if (d.reason === 'none') {
        return { text: 'No milestones', tip: `No open milestones in ${d.project}`, err: false };
    }

    return { text: 'Milestones unavailable', tip: `${d.error ?? d.reason}\nRefresh (r) to retry`, err: true };
}
