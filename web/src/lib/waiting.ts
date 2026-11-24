// What waits on the user.

/** Waits on the user: a question or permission prompt, or idle with a reply that asks for a decision. */
export const waitsOnYou = (s: Session): boolean => !s.sidechain && !!(s.asking || (s.needsYou && s.status !== 'working'));

/** Chats waiting on you whose Needs you work row stands for them (the MR their question names): they get no row of their own. */
export const askedIds = (items: WorkItem[]): Set<string> => new Set(items.flatMap(x => (x.column === 'needs-you' && x.askedBy ? [x.askedBy] : [])));

/** What waits on you in these sessions: Needs you items plus chats asking or needing you, each question once. */
export function waitingCount(mine: Session[]): number {
    const needs = mine.flatMap(s => s.items || []).filter(x => x.column === 'needs-you');
    const asked = askedIds(needs);
    return needs.length + mine.filter(s => waitsOnYou(s) && !asked.has(s.id)).length;
}

/** Tracked projects (by name) with something waiting on you, for the project picker's cue. */
export function projectCounts(sessions: Session[], tracked: string[]): { project: string, waiting: number }[] {
    return [...tracked].sort((a, b) => a.localeCompare(b)).map(project => ({ project, waiting: waitingCount(sessions.filter(s => s.project === project)) }))
        .filter(c => c.waiting > 0);
}
