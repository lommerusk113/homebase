// Left column: work items grouped by what they wait on, and attention transitions.
import { api, $, el, COLUMNS, COL, LIFECYCLE, state, store, hooks, visibleSessions, ago, prChip, plain, foldable, waButton, tooltip, seenAt, markSeen, freshComments, authorSummary, updateTitle } from './core.js';
import { chatSession, bindChat, sendText } from './chat.js';
import { milestoneTag } from './milestone.js';


/** @param {Column} key */
const dot = key => { const d = el('span', 'dot' + (key === 'doing' ? ' live' : '')); d.style.setProperty('--c', `var(${COL[key].color})`); return d; };

// CI pill next to the MR chip: ✓ passed, ✗ failed, ● running/pending, grey for the rest; nothing without a pipeline.
const PIPE = { success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'], preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled'] };
/** @param {Pipeline | null | undefined} p @returns {HTMLElement[]} */
export function ciPill(p) {
    if (!p?.status) return [];
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const a = el(p.url ? 'a' : 'span', `ci-pill ci-${p.status}`, icon);
    if (a instanceof HTMLAnchorElement) { a.href = p.url; a.target = '_blank'; a.onclick = e => e.stopPropagation(); }
    const when = p.at && ago(Date.parse(p.at));
    a.setAttribute('aria-label', `Pipeline ${word}`);
    return [a, tooltip(a, `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}`)];
}

// review-gate badge next to the MR chip: ✓ gate (ready), ⚠ gate (fix first), gate stale once the MR head moved; nothing if it never ran.
/** @param {Gate | null} g @returns {HTMLElement[]} */
function gateBadge(g) {
    if (!g) return [];
    const [cls, label] = g.stale ? ['stale', 'gate stale'] : g.verdict === 'ready' ? ['ready', '✓ gate'] : ['fix', '⚠ gate'];
    const b = el('span', `gate-badge gate-${cls}`, label);
    const when = g.at && ago(g.at);
    const tip = [`review-gate: ${g.verdict}${g.stale ? ' (MR changed since)' : ''}`, when && (when === 'now' ? 'just now' : `${when} ago`), plain(g.tldr)].filter(Boolean).join(' · ');
    b.setAttribute('aria-label', tip);
    return [b, tooltip(b, tip)];
}

// Work items (one per MR, plus running/stopped agents without one), grouped by what they wait on; recently finished and merged ones folded at the bottom.
function renderItems() {
    const items = visibleSessions().flatMap(s => s.items || []).filter(x => hooks.inMilestone(x)).map(x => optimistic(x)).sort((a, b) => b.updated - a.updated);
    /** @param {WorkItem[]} list */
    const table = list => {
        const t = el('table', 'rows');
        t.setAttribute('role', 'grid');
        t.append(...list.flatMap(x => {
            const tr = el('tr', state.selected === x.key ? 'sel' : '');
            tr.dataset.key = x.key;
            const what = el('td', 'what');
            const fresh = x.pr ? freshComments(x.comments, seenAt(x.pr)) : [];
            const next = el('small', 'next', `Next: ${x.next}${fresh.length ? ` · ${fresh.length} new comment${fresh.length === 1 ? '' : 's'}` : ''}`);
            // before Next, so the ellipsis doesn't cut it
            if (unanswered.has(x.key) && x.action && !x.sent && !x.requested) next.prepend(el('span', 'no-reply', 'No response yet — check the chat · '));
            if (x.comments?.count) next.prepend(commentBadge(x, fresh), ' ');
            what.append(el('b', null, x.title), next);
            if (x.milestone) what.firstElementChild.prepend(milestoneTag(x));
            const prog = el('td', 'prog'); prog.append(stageBar(x));
            if (x.tokens || x.time) {
                const m = el('small', 'meta', [x.tokens, x.time].filter(Boolean).join(' · '));
                prog.append(m);
                if (x.tokensTitle) prog.append(tooltip(m, x.tokensTitle));
            }
            const pr = el('td', 'pr'); if (x.pr) pr.append(prChip(x), ...ciPill(x.prState?.pipeline), ...gateBadge(x.gate));
            const br = el('td', 'br'); if (x.branch) br.append(el('span', 'chip mono', x.branch));
            const act = el('td', 'act'); act.append(...openButton(x));
            if (x.sent || x.requested) act.append(sentPill(x));
            else if (x.action && x.sessionId) act.append(...actionButton(x));
            tr.append(what, prog, pr, br, act, el('td', 'when', ago(x.updated)));
            tr.onclick = () => select(x);
            if (state.selected !== x.key) return [tr];
            const more = el('tr', 'detail'), td = el('td');
            td.colSpan = 6; td.append(detail(x)); more.append(td);
            return [tr, more];
        }));
        return t;
    };
    // Folded groups: Merged stays open for this page load once opened; Recently finished remembers per project, after a toggle.
    /** @param {typeof COLUMNS[number]} c @param {WorkItem[]} list @param {boolean} isOpen @param {(open: boolean) => void} setOpen */
    const fold = (c, list, isOpen, setOpen) => {
        const f = el('wa-details', `group g-${c.key}`), sum = el('span', 'g-head');
        f.setAttribute('appearance', 'plain');
        f.toggleAttribute('open', isOpen);
        sum.slot = 'summary';
        sum.append(dot(c.key), `${c.label} (${list.length})`);
        // tooltips inside also fire wa-show/wa-hide, and those bubble
        f.addEventListener('wa-show', e => { if (e.target === f) setOpen(true); });
        f.addEventListener('wa-hide', e => { if (e.target === f) setOpen(false); });
        f.append(sum, table(list));
        return f;
    };
    const finishedKey = `fold:finished:${state.project}`;
    const groups = COLUMNS.map(c => {
        const list = items.filter(x => x.column === c.key);
        if (!list.length) return null;
        if (c.key === 'done') return fold(c, list, !!state.showMerged, v => { state.showMerged = v; });
        if (c.key === 'finished') return fold(c, list, store.get(finishedKey) === 'open', v => store.set(finishedKey, v ? 'open' : 'closed'));
        const h = el('h2', 'g-head'); h.append(dot(c.key), `${c.label} · ${list.length}`);
        const sec = el('section', `group g-${c.key}`); sec.append(h, table(list));
        return sec;
    }).filter(Boolean);
    const hadFocus = $('masters').contains(document.activeElement); // replaceChildren drops it; keys.js puts it back
    $('masters').replaceChildren(...groups);
    if (!groups.length) $('masters').append(el('div', 'welcome', 'Nothing in flight.'));
    hooks.rendered?.(hadFocus);
}

// "💬 2 new · Børre" in the accent colour, or a muted "💬 5" when none are new since last checked.
/** @param {WorkItem} x @param {ReviewComment[]} fresh */
function commentBadge(x, fresh) {
    const b = el('span', 'cm-badge' + (fresh.length ? ' new' : ''), fresh.length ? `💬 ${fresh.length} new · ${authorSummary(fresh)}` : `💬 ${x.comments.count}`);
    b.setAttribute('aria-label', fresh.length ? `${fresh.length} new comments` : `${x.comments.count} comments, none new`);
    return b;
}
const markAllSeen = () => { for (const x of state.sessions.flatMap(s => s.items || [])) if (x.pr) markSeen(x.pr); renderBoard(); updateTitle(); };

// Optimistic "sent" marks: item key -> click time, in memory and sessionStorage, until the server reports the item
// requested or doing, or SENT_MS pass without that (then the button comes back with a hint).
const SENT_MS = 120_000;
const sent = new Map((() => { try { return JSON.parse(sessionStorage.getItem('sent')) ?? []; } catch { return []; } })());
const unanswered = new Set(); // keys whose mark timed out
const saveSent = () => { try { sessionStorage.setItem('sent', JSON.stringify([...sent])); } catch {} };
/** @param {WorkItem} x @returns {WorkItem} */
function optimistic(x, now = Date.now()) {
    const at = sent.get(x.key);
    if (at == null) return x;
    if (x.requested || x.column === 'doing' || now - at > SENT_MS) {
        sent.delete(x.key); saveSent();
        if (!x.requested && x.column !== 'doing') unanswered.add(x.key);
        return x;
    }
    return { ...x, sent: at, column: 'doing', next: 'Sent to Claude…' };
}
/** @param {WorkItem} x */
function sentPill(x) {
    const p = el('span', 'sent-pill');
    p.append(el('span', 'pulse'), x.sent ? 'Sent to Claude…' : 'Claude is on it…');
    p.setAttribute('role', 'status');
    return p;
}

// The row's one-click command (label and message from the server's rowAction): binds the chat to the item's session and sends
// there; the row turns into an in-progress one at once, without the button, so it can't be sent twice.
/** @param {WorkItem} x */
function actionButton(x) {
    const b = waButton(x.action.label, 'act-btn');
    b.onclick = async e => {
        e.stopPropagation();
        if (sent.has(x.key)) return;
        sent.set(x.key, Date.now()); saveSent(); unanswered.delete(x.key);
        if (x.sessionId !== chatSession()?.id) bindChat(x.sessionId); else renderBoard();
        setTimeout(renderBoard, SENT_MS + 500);
        if (!await sendText(x.sessionId, x.action.message)) { sent.delete(x.key); saveSent(); renderBoard(); } // sendText shows the error
    };
    return [b, tooltip(b, x.action.message)];
}

// Open the item's folder (worktree, else repo; resolved on the server) in an editor. Several editors: a menu, last pick first.
const CODE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
/** @param {WorkItem} x @returns {HTMLElement[]} */
function openButton(x) {
    const eds = state.editors ?? [];
    if (!x.folder || !eds.length) return [];
    const last = store.get('editor'), ordered = [...eds.filter(e => e.id === last), ...eds.filter(e => e.id !== last)];
    const open = /** @param {Editor} ed */ ed => { store.set('editor', ed.id); api(`/api/open?item=${encodeURIComponent(x.key)}&editor=${ed.id}`, { method: 'POST' }); };
    const b = waButton('', 'open-btn', { appearance: 'plain', 'aria-label': ordered.length > 1 ? 'Open in editor' : `Open in ${ordered[0].name}` });
    b.innerHTML = CODE_ICON;
    const tip = tooltip(b, b.getAttribute('aria-label'));
    if (ordered.length === 1) {
        b.onclick = e => { e.stopPropagation(); open(ordered[0]); };
        return [b, tip];
    }
    const dd = el('wa-dropdown');
    b.slot = 'trigger';
    dd.append(b, ...ordered.map(ed => { const i = el('wa-dropdown-item', null, `Open in ${ed.name}`); i.value = ed.id; return i; }));
    dd.onclick = e => e.stopPropagation();
    dd.addEventListener('wa-select', e => open(eds.find(ed => ed.id === e.detail.item.value)));
    return [dd, tip];
}

// Click toggles an inline detail (TLDR with Show more, other agents on the item, edited files) and binds the chat to the item's session.
/** @param {WorkItem} x */
export function select(x) {
    state.selected = state.selected === x.key ? null : x.key;
    // opening marks the MR seen; the detail still lists what was new until then
    if (state.selected && x.pr) { state.opened = { key: x.key, since: seenAt(x.pr) }; markSeen(x.pr); updateTitle(); }
    if (x.sessionId && x.sessionId !== chatSession()?.id) bindChat(x.sessionId); else renderBoard();
}
/** @param {WorkItem} x */
function detail(x) {
    const d = el('div', 'detail');
    if (x.comments?.count) {
        const fresh = freshComments(x.comments, state.opened?.key === x.key ? state.opened.since : seenAt(x.pr));
        const h = el('h4', null, fresh.length ? `New comments · ${fresh.length}` : `Comments · ${x.comments.count} · none new`), all = el('button', 'show mark-all', 'Mark all seen');
        all.onclick = markAllSeen;
        h.append(all); d.append(h);
        if (fresh.length) {
            const ul = el('ul', 'comments');
            ul.append(...fresh.map(c => {
                const li = el('li'), a = el('a', null, c.excerpt || '(no text)');
                a.href = c.url; a.target = '_blank';
                li.append(el('b', null, c.author), el('span', 'muted', ` · ${ago(Date.parse(c.at))}${c.resolved === false ? ' · unresolved' : ''} · `), a);
                return li;
            }));
            d.append(ul);
        }
    }
    if (x.tldr || x.body) d.append(...foldable(x.tldr, x.body, `item:${x.key}`));
    if (x.activity?.length) {
        const ul = el('ul', 'activity');
        ul.append(...x.activity.map(a => {
            const li = el('li'), badge = el('wa-badge', null, a.status);
            badge.setAttribute('variant', 'neutral'); badge.setAttribute('appearance', 'filled'); badge.setAttribute('pill', '');
            li.append(badge, ' ', el('b', null, a.description), a.tldr ? ` — ${plain(a.tldr)}` : '');
            return li;
        }));
        d.append(el('h4', null, `Earlier agents · ${x.activity.length}`), ul);
    }
    if (x.files?.length) {
        const ul = el('ul', 'files');
        ul.append(...x.files.map(f => { const li = el('li'), i = f.lastIndexOf('/'); li.title = f; li.append(f.slice(0, i + 1), el('b', null, f.slice(i + 1))); return li; }));
        d.append(el('h4', null, `Files edited · ${x.files.length}`), ul);
    }
    if (!d.children.length) d.append(el('p', 'muted', 'Nothing to show yet.'));
    d.onclick = e => e.stopPropagation();
    return d;
}
// Lifecycle Implement → Verify → Review → Approved → Merged; the current segment pulses while an agent runs.
/** @param {WorkItem} x */
function stageBar(x) {
    const w = el('div', 'stage'), bar = el('div', 'bar');
    w.style.setProperty('--c', `var(${COL[x.column].color})`);
    LIFECYCLE.forEach((name, i) => { const s = el('i', i < x.stage ? 'on' : i === x.stage ? (x.agentStatus === 'running' || x.sent || x.requested ? 'on now' : 'on') : ''); s.title = name; bar.append(s); });
    w.append(bar, el('small', null, x.stageLabel));
    return w;
}

export function renderBoard() {
    if (!state.tracked.length) {
        const w = el('div', 'welcome'), b = waButton('+ Add projects', null, { variant: 'success', appearance: 'accent', size: 'm' });
        w.append(el('h2', null, 'No projects on your board'), el('div', null, 'Pick the projects you want to follow. Sessions from other projects stay hidden.'), b);
        b.onclick = () => $('manage').click();
        return $('masters').replaceChildren(w);
    }
    renderItems();
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
    if (!prevItems) return [];
    const before = new Map(prevItems.map(x => [x.key, x])), now = new Set(nextItems.map(x => x.key));
    const failing = /** @param {WorkItem | undefined} x */ x => x?.prState?.ci === 'failing';
    const events = nextItems.flatMap(x => {
        const p = before.get(x.key), was = p?.column;
        const kind = x.column === 'needs-you' && was !== 'needs-you' ? 'needs-you'
            : x.column === 'ready' && was !== 'ready' ? 'ready'
            : was === 'doing' && (x.column === 'review' || x.column === 'done' || x.column === 'finished') ? 'finished'
            : failing(x) && !failing(p) ? 'failing' : null;
        return kind ? [/** @type {AttentionEvent} */ ({ kind, item: x })] : [];
    });
    const comments = nextItems.flatMap(x => {
        const p = before.get(x.key);
        if (!x.pr || !x.comments || !p?.comments) return [];
        const fresh = freshComments(x.comments, Math.max(seen(x), Date.parse(p.comments.latestAt) || 0));
        return fresh.length ? [/** @type {AttentionEvent} */ ({ kind: 'comment', item: x, comments: fresh })] : [];
    });
    // one notification per item: a comment that moved it into needs-you is told as the comment
    const commented = new Set(comments.map(e => e.item.key));
    // finished agents without an MR drop off the board
    return [...events.filter(e => !(e.kind === 'needs-you' && commented.has(e.item.key))), ...comments, ...prevItems.filter(p => p.column === 'doing' && !now.has(p.key)).map(item => /** @type {AttentionEvent} */ ({ kind: 'finished', item }))];
}
