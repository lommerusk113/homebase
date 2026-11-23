// Issues tab: the selected milestone's open issues in one lane per person (you first, then A–Z, then Unassigned).
// The logic only: the tab is drawn by the Issues island (web/src/islands/Issues.vue) from useIssues.ts.
import { $, store, hooks, forgeWords } from './core.js';
import { canned } from './canned.js';

export const STATES = { doing: 'in progress', closable: 'can be closed', todo: 'not started', free: 'unassigned' };

// Open issues as cards with their state, in lane order: in progress, can be closed, not started, unassigned.
/** @typedef {Issue & { st: keyof typeof STATES }} Card */

/** @param {IssueGroups} groups @returns {Card[]} */
export function issueCards(groups) {
    return [['doing', 'doing'], ['closable', 'closable'], ['assigned', 'todo'], ['unassigned', 'free']]
        .flatMap(([g, st]) => groups[g].map(i => ({ ...i, st })));
}

// Who a card belongs to: its assignees, else the authors of its MRs (an in-progress issue nobody assigned).
/** @param {Card | Issue} card @returns {Person[]} */
export function owners(card) {
    if (card.assignees.length) {
        return card.assignees;
    }
    return [...new Map(card.mrs.filter(m => m.author).map(m => [m.author.username, m.author])).values()];
}

// Lanes [{ who: { name, username } | null, me, list, closed }]: you first, others by name, Unassigned last (always there).
// done: the milestone's closed issues, counted per assignee.
/** @typedef {{ who: Person | null, me: boolean, list: Card[], closed: number }} Lane */
/** @param {Card[]} cards @param {Issue[]} done @param {Person | null} me @returns {Lane[]} */
export function buildLanes(cards, done, me) {
    const lanes = new Map();
    for (const c of cards) {
        for (const p of owners(c)) {
            if (!lanes.has(p.username)) {
                lanes.set(p.username, { who: p, me: p.username === me?.username, list: [], closed: 0 });
            }
            lanes.get(p.username).list.push(c);
        }
    }
    const free = { who: null, me: false, list: cards.filter(c => !owners(c).length), closed: 0 };
    for (const i of done) {
        if (!i.assignees.length) {
            free.closed++;
        }
        for (const p of i.assignees) {
            if (lanes.has(p.username)) {
                lanes.get(p.username).closed++;
            }
        }
    }
    return [...[...lanes.values()].sort((a, b) => b.me - a.me || a.who.name.localeCompare(b.who.name)), free];
}

// Closed issues per assignee for the folded Closed line: [[name, n]] by name, unassigned last.
/** @param {Issue[]} done @returns {[string, number][]} */
export function closedBy(done) {
    const n = new Map();
    for (const i of done) {
        for (const k of i.assignees.length ? i.assignees.map(p => p.name) : ['unassigned']) {
            n.set(k, (n.get(k) ?? 0) + 1);
        }
    }
    // @ts-expect-error boolean minus boolean is 0/1/-1 at runtime, the intended sort key
    return [...n].sort((a, b) => (a[0] === 'unassigned') - (b[0] === 'unassigned') || a[0].localeCompare(b[0]));
}

// What "Send to chat" types: start a not-started issue, close one whose MR is merged, or check on one with an MR (its open MR first).
// An MR closed without merging is no work on the issue: with only those it starts afresh.
/** @param {Issue & { st?: string }} card */
export function chatMessage(card) {
    const pr = (/** @type {IssueMr} */ m) => forgeWords(m.url).mr === 'PR'; // GitHub writes it "PR #12", GitLab "!12"
    const mr = card.mrs.find(m => m.state === 'open') ?? card.mrs.find(m => m.state !== 'closed');
    if (card.st === 'closable' && mr) {
        const m = card.mrs.find(x => x.state === 'merged') ?? mr;
        return canned(pr(m) ? 'closePr' : 'close', card.iid, m.iid).message;
    }
    return (mr ? canned(pr(mr) ? 'checkPr' : 'check', card.iid, mr.iid) : canned('start', card.iid)).message;
}

// "Supplier automation: undo in the grid" -> "undo in the grid" when the prefix is the milestone's name.
/** @param {string} title @param {string} milestone */
export const shortTitle = (title, milestone) => {
    const m = title.match(/^([^:]{1,60}):\s+(.+)$/);
    return m && m[1].toLowerCase().startsWith(milestone.toLowerCase()) ? m[2] : title;
};

// The Issues tab's line for a project without milestones to show (d.reason from /api/milestones).
/** @param {Milestones} d */
export function emptyText(d) {
    if (d.reason === 'none') {
        return `No open milestones in ${d.project}.`;
    }
    if (d.reason === 'unsupported') {
        return `Milestones aren't available for ${d.project}: ${d.error ?? 'unknown project'}.`;
    }
    return `Milestones unavailable for ${d.project}: ${d.error ?? 'unknown error'}. Press r or the refresh button to retry.`;
}

// The board's two views: Work (the item list) and Issues, switched by the header's segmented control (#tabs).
// 1 and 2 pick one, t swaps (keys.js); the choice survives reloads.
/** @param {string | null} tab */
export function showTab(tab) {
    tab = tab === 'issues' ? tab : 'work';
    store.set('tab', tab);
    $('tabs').dataset.tab = tab; // moves the selected segment's thumb (styles.css .seg)
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs button'))) {
        b.setAttribute('aria-selected', String(b.dataset.tab === tab));
        b.tabIndex = b.dataset.tab === tab ? 0 : -1;
    }
    $('masters').hidden = tab !== 'work';
    $('issues').hidden = tab !== 'issues';
}
export const activeTab = () => ($('issues').hidden ? 'work' : 'issues');

// Esc in the Issues tab folds the open card (the Issues island, useIssues); false when there was none.
export const collapseIssue = () => hooks.collapseIssue?.() ?? false;
