// What waits on the user.

/** Waits on the user: a question or permission prompt, or idle with a reply that asks for a decision. */
export const waitsOnYou = (s: Session): boolean => !s.sidechain && !!(s.asking || (s.needsYou && s.status !== 'working'));

/** Tracked projects (by name) with something waiting on you, for the project picker's cue: Needs you items plus chats asking or needing you. */
export function projectCounts(sessions: Session[], tracked: string[]): { project: string, waiting: number }[] {
    return [...tracked].sort((a, b) => a.localeCompare(b)).map(project => {
        const mine = sessions.filter(s => s.project === project);
        return { project, waiting: mine.flatMap(s => s.items || []).filter(x => x.column === 'needs-you').length + mine.filter(waitsOnYou).length };
    }).filter(c => c.waiting > 0);
}
