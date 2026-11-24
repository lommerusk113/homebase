// The milestone filter's logic: what the header pill says and which work items it keeps.

/** "due 1 Dec 2026" for a date like "2026-12-01". */
export const due = (d: string | null | undefined): string => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');

// The issue a row works on: its MR's, else the leading number of its branch or worktree (2263-dimension-links), else a #N in its title.
export function issueOfItem(item: WorkItem): number | null {

    const ref = item.prState?.issue ?? [item.branch, item.worktreePath?.split('/').pop()].map(b => b?.match(/^(\d+)-/)?.[1]).find(Boolean)
        ?? item.title?.match(/#(\d+)(?!\d)/)?.[1];

    return ref ? Number(ref) : null;
}

// Whether a work item stays in the list for the selected milestone ({ id, issues }, or null for none): an MR of that
// milestone; a row without an MR whose issue is among the milestone's issues (issues: their numbers, null until loaded);
// and every row whose milestone is unknown: an MR not checked yet (no prState), a row without an MR or issue ref, or
// with the issues not loaded. An MR of another milestone or none is hidden, even when it waits on you.
export function inMilestone(item: WorkItem, selected: { id: number, issues?: Set<number> | null, hold?: boolean } | null): boolean {

    if (!selected) {
        return true;
    }
    if (item.pr) {
        return !item.prState || item.milestone?.id === selected.id;
    }
    const n = issueOfItem(item);

    // hold: the stored choice's issues are still on their way, so a row with an issue ref waits for them
    return n == null || (selected.issues ? selected.issues.has(n) : !selected.hold);
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
