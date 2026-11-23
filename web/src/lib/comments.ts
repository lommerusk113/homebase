// Review comments: which are new and who wrote them.

export const freshComments = (c: Comments | null | undefined, seen: number): ReviewComment[] => (c?.items ?? []).filter(i => Date.parse(i.at) > seen);

export const firstName = (n: string): string => n.split(/\s+/)[0];

/** "Børre" / "Børre, Ann" / "Børre, Ann +1": distinct first names, at most two. */
export const authorSummary = (items: ReviewComment[]): string => {
    const n = [...new Set(items.map(i => firstName(i.author)))];
    return n.slice(0, 2).join(', ') + (n.length > 2 ? ` +${n.length - 2}` : '');
};
