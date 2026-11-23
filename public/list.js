// Left column: what the board's rows are made of and its attention transitions. The board itself is the Board island (web/src/islands/Board.vue).
import { $, state, ago, seenAt, markSeen, freshComments, updateTitle, waitsOnYou, vue } from './core.js';
import { chatSession, bindChat, focusChat } from './chat.js';

// A pipeline as the CI pill shows it: ✓ passed, ✗ failed, ● running/pending, grey for the rest, with its tooltip; null without a pipeline.
const PIPE = { success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'], preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled'] };
/** @param {Pipeline | null | undefined} p @returns {{ icon: string, label: string, tip: string } | null} */
export function pipeWords(p) {
    if (!p?.status) {
        return null;
    }
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const when = p.at && ago(Date.parse(p.at));
    return { icon, label: `Pipeline ${word}`, tip: `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}` };
}

// What the session is on: its newest reply's topic, else the start of its last prompt.
/** @param {Pick<Session, 'topic' | 'lastPrompt'>} s */
export function sessionTopic(s) {
    if (s.topic) {
        return s.topic;
    }
    return excerpt(s.lastPrompt) || 'No prompt yet';
}
// plain() would also drop the # of "#2225"; only markdown emphasis and leading heading marks go here
/** @param {string | null | undefined} t */
export const excerpt = (t, n = 80) => {
    const p = (t || '').replace(/[*_`>]+|^\s*#+\s+/g, '').replace(/\s+/g, ' ').trim();
    return p.length > n ? p.slice(0, n).replace(/\s+\S*$/, '') + '…' : p;
};
// The issues (#N) a chat's running or queued prompts name.
/** @param {Session} s @returns {string[]} */
const askedIssues = s => [...new Set([s.status === 'working' ? s.now : null, ...(s.queued ?? [])].flatMap(t => [...(t ?? '').matchAll(/(?<![\w&!#])#(\d+)\b/g)].map(m => m[1])))];
// A work item is on issue n: its MR's issue, "#n" in its title, or a branch named "n-…".
/** @param {WorkItem} x @param {string} n */
const covers = (x, n) => String(x.prState?.issue ?? '') === n || new RegExp(`#${n}(?!\\d)`).test(x.title ?? '') || !!x.branch?.startsWith(`${n}-`);
// Issues (#N) the session's running or queued prompts name that no work item covers yet: placeholder rows in Doing.
/** @param {Session} s @param {WorkItem[]} items the project's items @returns {string[]} */
export function startingIssues(s, items) {
    return askedIssues(s).filter(n => !items.some(x => covers(x, n)));
}
// Who already works on issue n in these sessions (one project's): the work item on it (not one whose MR is merged or was closed),
// else the chat whose running or queued prompt names it. null when nobody does.
/** @param {string} n @param {Session[]} sessions @returns {{ sessionId: string | null, key: string | null } | null} */
export function issueWork(n, sessions) {
    const item = sessions.flatMap(s => s.items || []).find(x => x.column !== 'done' && x.column !== 'closed' && covers(x, n));
    if (item) {
        return { sessionId: item.sessionId, key: item.key };
    }
    const s = sessions.find(s => askedIssues(s).includes(n));
    return s ? { sessionId: s.id, key: null } : null;
}

// "project · Now: <step> · for 2m" for a working main chat; the time is since its newest tool call, else its turn start.
/** @param {Session} s */
export function workingLine(s) {
    const t = ago(s.stepAt ?? s.since ?? s.lastActivity ?? s.updated);
    return `${s.project} · Now: ${s.step || 'thinking'}${t === 'now' ? '' : ` · for ${t}`}`;
}
// What a working chat is on: the request its turn handles (no pasted image paths), else its newest reply's topic, else its title.
/** @param {Session} s */
export function workingTitle(s) {
    const asked = excerpt((s.now ?? '').replace(/\[Image: [^\]]*\]/g, ''), 100);
    // a short answer ("do it", "yes go ahead") says nothing on its own: the reply it answers names the work
    const short = asked.split(' ').length <= SHORT_WORDS;
    return (short && s.topic) || asked || s.topic || s.title || sessionTopic(s);
}
const SHORT_WORDS = 3;

// "all waiting on Ann" when every row's next step is the same "Waiting for review by Ann", else ''.
/** @param {WorkItem[]} list */
export function reviewNote(list) {
    const m = list[0]?.next?.match(/^Waiting for review by (.+)$/);

    return m && list.every(x => x.next === list[0].next) ? `all waiting on ${m[1]}` : '';
}

// Click toggles an inline detail (TLDR with Show more, other agents on the item, edited files) and binds the chat to the item's session.
/** @param {WorkItem} x */
export function select(x) {
    state.selected = state.selected === x.key ? null : x.key;
    // opening marks the MR seen; the detail still lists what was new until then
    if (state.selected && x.pr) {
        state.opened = { key: x.key, since: seenAt(x.pr) };
        markSeen(x.pr);
        updateTitle();
    }
    if (state.selected && x.sessionId && x.sessionId !== chatSession()?.id) { // opening only: closing a detail leaves the chat alone
        (x.column === 'needs-you' ? focusChat : bindChat)(x.sessionId);
    } else {
        renderBoard();
    }
    if (state.selected) { // a row opened low on the board: its detail comes into view (a frame later, once the island has drawn it)
        requestAnimationFrame(() => document.querySelector('#masters tr.detail')?.scrollIntoView({ block: 'nearest' }));
    }
}

// Redraws the board: the island is mounted once and follows each bump. Without web/dist there is no board (web/README.md).
let mounted = false;
export function renderBoard() {
    if (!mounted) {
        mounted = true;
        vue.load().then(m => m?.mount('Board', $('masters')));
    }
    vue.bump();
}

// Transitions into an attention state since the previous poll, at most one per item, plus a comment event per item with
// comments newer than both its seen time and the previous poll's newest. No previous poll (or comments not loaded then), no events.
/**
 * @param {WorkItem[] | undefined} prevItems
 * @param {WorkItem[]} nextItems
 * @param {(x: WorkItem) => number} [seen]
 * @returns {AttentionEvent[]}
 */
export function attentionEvents(prevItems, nextItems, seen = () => 0) {
    if (!prevItems) {
        return [];
    }
    const before = new Map(prevItems.map(x => [x.key, x])), nextKeys = new Set(nextItems.map(x => x.key));
    const failing = /** @param {WorkItem | undefined} x */ x => x?.prState?.ci === 'failing';
    const events = nextItems.flatMap(x => {
        const p = before.get(x.key), was = p?.column;
        const kind = x.column === 'needs-you' && was !== 'needs-you' ? 'needs-you'
            : x.column === 'ready' && was !== 'ready' ? 'ready'
            : was === 'doing' && (x.column === 'review' || x.column === 'done' || x.column === 'closed' || x.column === 'finished') ? 'finished'
            : failing(x) && !failing(p) ? 'failing' : null;
        return kind ? [/** @type {AttentionEvent} */ ({ kind, item: x })] : [];
    });
    const comments = nextItems.flatMap(x => {
        const p = before.get(x.key);
        if (!x.pr || !x.comments || !p?.comments) {
            return [];
        }
        const fresh = freshComments(x.comments, Math.max(seen(x), Date.parse(p.comments.latestAt) || 0));
        return fresh.length ? [/** @type {AttentionEvent} */ ({ kind: 'comment', item: x, comments: fresh })] : [];
    });
    // one notification per item: a comment that moved it into needs-you is told as the comment
    const commented = new Set(comments.map(e => e.item.key));
    // finished agents without an MR drop off the board
    return [...events.filter(e => !(e.kind === 'needs-you' && commented.has(e.item.key))), ...comments, ...prevItems.filter(p => p.column === 'doing' && !nextKeys.has(p.key)).map(item => /** @type {AttentionEvent} */ ({ kind: 'finished', item }))];
}

// Sessions that started waiting on the user (asking, or needs you) since the previous poll. No previous poll, no events.
/** @param {Session[] | undefined} prev @param {Session[]} next @returns {AttentionEvent[]} */
export function askingEvents(prev, next) {
    if (!prev) {
        return [];
    }
    const was = new Set(prev.filter(waitsOnYou).map(s => s.id));
    return next.filter(s => waitsOnYou(s) && !was.has(s.id)).map(session => /** @type {AttentionEvent} */ ({ kind: 'asking', session }));
}
