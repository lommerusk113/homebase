// Left column: work items grouped by what they wait on, and attention transitions.
import { api, $, el, COLUMNS, COL, LIFECYCLE, state, store, hooks, visibleSessions, ago, prChip, plain, foldable, waButton, tooltip } from './core.js';
import { chatSession, bindChat, sendText } from './chat.js';
import { milestoneTag } from './milestone.js';


const dot = key => { const d = el('span', 'dot' + (key === 'doing' ? ' live' : '')); d.style.setProperty('--c', `var(${COL[key].color})`); return d; };

// CI pill next to the MR chip: ✓ passed, ✗ failed, ● running/pending, grey for the rest; nothing without a pipeline.
const PIPE = { success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'], preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled'] };
export function ciPill(p) {
    if (!p?.status) return [];
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const a = el(p.url ? 'a' : 'span', `ci-pill ci-${p.status}`, icon);
    if (p.url) { a.href = p.url; a.target = '_blank'; a.onclick = e => e.stopPropagation(); }
    const when = p.at && ago(Date.parse(p.at));
    a.setAttribute('aria-label', `Pipeline ${word}`);
    return [a, tooltip(a, `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}`)];
}

// Work items (one per MR, plus running/stopped agents without one), grouped by what they wait on; merged ones folded at the bottom.
function renderItems() {
    const items = visibleSessions().flatMap(s => s.items || []).filter(x => hooks.inMilestone(x)).sort((a, b) => b.updated - a.updated);
    const table = list => {
        const t = el('table', 'rows');
        t.setAttribute('role', 'grid');
        t.append(...list.flatMap(x => {
            const tr = el('tr', state.selected === x.key ? 'sel' : '');
            tr.dataset.key = x.key;
            const what = el('td', 'what');
            what.append(el('b', null, x.title), el('small', 'next', `Next: ${x.next}`));
            if (x.milestone) what.firstChild.prepend(milestoneTag(x));
            const prog = el('td', 'prog'); prog.append(stageBar(x));
            if (x.tokens || x.time) {
                const m = el('small', 'meta', [x.tokens, x.time].filter(Boolean).join(' · '));
                prog.append(m);
                if (x.tokensTitle) prog.append(tooltip(m, x.tokensTitle));
            }
            const pr = el('td', 'pr'); if (x.pr) pr.append(prChip(x), ...ciPill(x.prState?.pipeline));
            const br = el('td', 'br'); if (x.branch) br.append(el('span', 'chip mono', x.branch));
            const act = el('td', 'act'); act.append(...openButton(x)); if (x.action && x.sessionId) act.append(...actionButton(x));
            tr.append(what, prog, pr, br, act, el('td', 'when', ago(x.updated)));
            tr.onclick = () => select(x);
            if (state.selected !== x.key) return [tr];
            const more = el('tr', 'detail'), td = el('td');
            td.colSpan = 6; td.append(detail(x)); more.append(td);
            return [tr, more];
        }));
        return t;
    };
    const groups = COLUMNS.filter(c => c.key !== 'done').map(c => {
        const list = items.filter(x => x.column === c.key);
        if (!list.length) return null;
        const h = el('h2', 'g-head'); h.append(dot(c.key), `${c.label} · ${list.length}`);
        const sec = el('section', 'group'); sec.append(h, table(list));
        return sec;
    }).filter(Boolean);
    const merged = items.filter(x => x.column === 'done');
    if (merged.length) {
        const fold = el('wa-details', 'group merged'), sum = el('span', 'g-head');
        fold.setAttribute('appearance', 'plain');
        fold.toggleAttribute('open', !!state.showMerged);
        sum.slot = 'summary';
        sum.append(dot('done'), `Merged (${merged.length})`);
        // tooltips inside also fire wa-show/wa-hide, and those bubble
        fold.addEventListener('wa-show', e => { if (e.target === fold) state.showMerged = true; });
        fold.addEventListener('wa-hide', e => { if (e.target === fold) state.showMerged = false; });
        fold.append(sum, table(merged));
        groups.push(fold);
    }
    const hadFocus = $('masters').contains(document.activeElement); // replaceChildren drops it; keys.js puts it back
    $('masters').replaceChildren(...groups);
    if (!groups.length) $('masters').append(el('div', 'welcome', 'Nothing in flight.'));
    hooks.rendered?.(hadFocus);
}

// The row's one-click command (label and message from the server's rowAction): binds the chat to the item's session and sends there.
const sentAt = new Map(); // item key -> last click, so a re-render keeps the button disabled
const COOLDOWN_MS = 3000;
function actionButton(x) {
    const cooling = () => Date.now() - (sentAt.get(x.key) ?? 0) < COOLDOWN_MS;
    const b = waButton(x.action.label, 'act-btn', cooling() ? { disabled: true } : {});
    b.onclick = e => {
        e.stopPropagation();
        if (cooling()) return;
        sentAt.set(x.key, Date.now());
        if (x.sessionId !== chatSession()?.id) bindChat(x.sessionId); else renderBoard();
        setTimeout(renderBoard, COOLDOWN_MS);
        sendText(x.sessionId, x.action.message);
    };
    return [b, tooltip(b, x.action.message)];
}

// Open the item's folder (worktree, else repo; resolved on the server) in an editor. Several editors: a menu, last pick first.
const CODE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>';
function openButton(x) {
    const eds = state.editors ?? [];
    if (!x.folder || !eds.length) return [];
    const last = store.get('editor'), ordered = [...eds.filter(e => e.id === last), ...eds.filter(e => e.id !== last)];
    const open = ed => { store.set('editor', ed.id); api(`/api/open?item=${encodeURIComponent(x.key)}&editor=${ed.id}`, { method: 'POST' }); };
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
export function select(x) {
    state.selected = state.selected === x.key ? null : x.key;
    if (x.sessionId && x.sessionId !== chatSession()?.id) bindChat(x.sessionId); else renderBoard();
}
function detail(x) {
    const d = el('div', 'detail');
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
function stageBar(x) {
    const w = el('div', 'stage'), bar = el('div', 'bar');
    w.style.setProperty('--c', `var(${COL[x.column].color})`);
    LIFECYCLE.forEach((name, i) => { const s = el('i', i < x.stage ? 'on' : i === x.stage ? (x.agentStatus === 'running' ? 'on now' : 'on') : ''); s.title = name; bar.append(s); });
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

// Transitions into an attention state since the previous poll, at most one per item. No previous poll, no events.
export function attentionEvents(prevItems, nextItems) {
    if (!prevItems) return [];
    const before = new Map(prevItems.map(x => [x.key, x])), now = new Set(nextItems.map(x => x.key));
    const failing = x => x?.prState?.ci === 'failing';
    const events = nextItems.flatMap(x => {
        const p = before.get(x.key), was = p?.column;
        const kind = x.column === 'needs-you' && was !== 'needs-you' ? 'needs-you'
            : x.column === 'ready' && was !== 'ready' ? 'ready'
            : was === 'doing' && (x.column === 'review' || x.column === 'done') ? 'finished'
            : failing(x) && !failing(p) ? 'failing' : null;
        return kind ? [{ kind, item: x }] : [];
    });
    // finished agents without an MR drop off the board
    return [...events, ...prevItems.filter(p => p.column === 'doing' && !now.has(p.key)).map(item => ({ kind: 'finished', item }))];
}
