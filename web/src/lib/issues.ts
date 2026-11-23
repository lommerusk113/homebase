// Issues tab: the selected milestone's open issues in one lane per person (you first, then A–Z, then Unassigned).
import { canned } from './canned.ts';
import { forgeWords } from './forge.ts';

export const STATES = { doing: 'in progress', closable: 'can be closed', todo: 'not started', free: 'unassigned' };

/** An open issue with its state. */
export type Card = Issue & { st: keyof typeof STATES };
export type Lane = { who: Person | null, me: boolean, list: Card[], closed: number };

/** Open issues as cards with their state, in lane order: in progress, can be closed, not started, unassigned. */
export function issueCards(groups: IssueGroups): Card[] {
    const lanes = [['doing', 'doing'], ['closable', 'closable'], ['assigned', 'todo'], ['unassigned', 'free']] as const;

    return lanes.flatMap(([g, st]) => groups[g].map(i => ({ ...i, st })));
}

/** Who a card belongs to: its assignees, else the authors of its MRs (an in-progress issue nobody assigned). */
export function owners(card: Card | Issue): Person[] {
    if (card.assignees.length) {
        return card.assignees;
    }
    return [...new Map(card.mrs.filter(m => m.author).map(m => [m.author!.username, m.author!])).values()];
}

// Lanes: you first, others by name, Unassigned last (always there).
// done: the milestone's closed issues, counted per assignee.
export function buildLanes(cards: Card[], done: Issue[], me: Person | null): Lane[] {
    const lanes = new Map<string, Lane>();
    for (const c of cards) {
        for (const p of owners(c)) {
            if (!lanes.has(p.username)) {
                lanes.set(p.username, { who: p, me: p.username === me?.username, list: [], closed: 0 });
            }
            lanes.get(p.username)!.list.push(c);
        }
    }
    const free: Lane = { who: null, me: false, list: cards.filter(c => !owners(c).length), closed: 0 };
    for (const i of done) {
        if (!i.assignees.length) {
            free.closed++;
        }
        for (const p of i.assignees) {
            if (lanes.has(p.username)) {
                lanes.get(p.username)!.closed++;
            }
        }
    }

    return [...[...lanes.values()].sort((a, b) => Number(b.me) - Number(a.me) || a.who!.name.localeCompare(b.who!.name)), free];
}

/** Closed issues per assignee for the folded Closed line: [[name, n]] by name, unassigned last. */
export function closedBy(done: Issue[]): [string, number][] {
    const n = new Map<string, number>();
    for (const i of done) {
        for (const k of i.assignees.length ? i.assignees.map(p => p.name) : ['unassigned']) {
            n.set(k, (n.get(k) ?? 0) + 1);
        }
    }

    return [...n].sort((a, b) => Number(a[0] === 'unassigned') - Number(b[0] === 'unassigned') || a[0].localeCompare(b[0]));
}

// What "Send to chat" types: start a not-started issue, close one whose MR is merged, or check on one with an MR (its open MR first).
// An MR closed without merging is no work on the issue: with only those it starts afresh.
export function chatMessage(card: Issue & { st?: string }): string {
    const pr = (m: IssueMr) => forgeWords(m.url).mr === 'PR'; // GitHub writes it "PR #12", GitLab "!12"
    const mr = card.mrs.find(m => m.state === 'open') ?? card.mrs.find(m => m.state !== 'closed');
    if (card.st === 'closable' && mr) {
        const m = card.mrs.find(x => x.state === 'merged') ?? mr;
        return canned(pr(m) ? 'closePr' : 'close', card.iid, m.iid).message;
    }

    return (mr ? canned(pr(mr) ? 'checkPr' : 'check', card.iid, mr.iid) : canned(card.assignees?.length ? 'start' : 'startUnassigned', card.iid)).message;
}

/** "Supplier automation: undo in the grid" -> "undo in the grid" when the prefix is the milestone's name. */
export const shortTitle = (title: string, milestone: string): string => {
    const m = title.match(/^([^:]{1,60}):\s+(.+)$/);
    return m && m[1].toLowerCase().startsWith(milestone.toLowerCase()) ? m[2] : title;
};

/** The Issues tab's line for a project without milestones to show (d.reason from /api/milestones). */
export function emptyText(d: Milestones): string {
    if (d.reason === 'none') {
        return `No open milestones in ${d.project}.`;
    }
    if (d.reason === 'unsupported') {
        return `Milestones aren't available for ${d.project}: ${d.error ?? 'unknown project'}.`;
    }
    return `Milestones unavailable for ${d.project}: ${d.error ?? 'unknown error'}. Press r or the refresh button to retry.`;
}
