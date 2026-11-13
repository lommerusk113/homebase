// Keyboard navigation over work-item rows (after Contado): j/k move, Enter/Space expand, o opens the MR, a runs the row action.
// The same j/k/Enter/o work on the Issues tab's cards; 1 and 2 switch tabs.
// The focused row is tracked by item key, so it survives the 3s re-renders; list.js calls hooks.rendered after each one.
import { $, el, state, hooks } from './core.js';
import { select, renderBoard } from './list.js';
import { showTab, activeTab, collapseIssue } from './issues.js';

export const SHORTCUTS = [
    ['j / ↓', 'Next item'], ['k / ↑', 'Previous item'], ['Enter / Space', 'Expand or collapse, chat with its session'],
    ['o', 'Open the MR in a new tab'], ['a', "Run the row's action (asks first)"], ['/ or c', 'Focus the chat input'],
    ['Esc', 'Leave the input, or collapse the row'], ['1 / 2', 'Work tab / Issues tab'], ['g then p', 'Project selector'], ['m', 'Milestone menu'], ['r', 'Refresh from GitLab/GitHub'], ['?', 'This overlay']
];
const KEYS = { j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'toggle', ' ': 'toggle', o: 'open', a: 'act', '/': 'chat', c: 'chat', Escape: 'escape', '?': 'help', m: 'milestone', r: 'refresh', g: 'g', 1: 'work', 2: 'issues' };

// Action for a keydown ({ key, metaKey, ctrlKey, altKey }); prev is 'g' when g was pressed just before.
export function keyAction(e, prev) {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (prev === 'g' && e.key === 'p') return 'project';
    return KEYS[e.key] ?? null;
}

// Key after (dir 1) or before (dir -1) current among the visible keys; clamps at the ends, starts at an end when current is gone.
export function stepKey(keys, current, dir) {
    if (!keys.length) return null;
    const i = keys.indexOf(current);
    if (i < 0) return dir > 0 ? keys[0] : keys.at(-1);
    return keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
}

let focusKey = null, prev = null, prevAt = 0;
const ROWS = '#masters tr[data-key], #issues .card[data-key]'; // work rows and issue cards; the hidden tab's are skipped below
const rows = () => [...document.querySelectorAll(ROWS)].filter(r => r.checkVisibility()); // skips the folded Merged group
const rowOf = key => rows().find(r => r.dataset.key === key);
const itemOf = key => state.sessions.flatMap(s => s.items || []).find(x => x.key === key);
const typing = path => path.some(n => n.isContentEditable || ['input', 'textarea', 'wa-input', 'wa-textarea'].includes(n.localName));
const menuOpen = path => !!document.querySelector('wa-dialog[open], wa-select[open], wa-dropdown[open], details.ms-pick[open]')
    || path.some(n => ['wa-select', 'wa-dialog', 'wa-dropdown'].includes(n.localName) || n.classList?.contains('ms-pick'));

// Roving tabindex and ARIA state on the rows; refocus puts DOM focus back on the tracked row after a re-render took it away.
function syncRows(refocus) {
    const all = [...document.querySelectorAll(ROWS)], cur = all.find(r => r.dataset.key === focusKey), first = cur || rows()[0];
    all.forEach(r => {
        r.tabIndex = r === first ? 0 : -1;
        r.setAttribute('aria-selected', r === cur);
        if (r.localName === 'tr') r.setAttribute('aria-expanded', r.dataset.key === state.selected);
    });
    if (refocus && cur) cur.focus({ preventScroll: true });
}

function focusRow(key) {
    const r = key && rowOf(key);
    if (!r) return;
    focusKey = key; syncRows();
    r.focus({ preventScroll: true });
    r.scrollIntoView({ block: 'nearest' });
}

function dialog(label, body, footer = []) {
    const d = el('wa-dialog');
    d.setAttribute('label', label); d.setAttribute('light-dismiss', '');
    d.append(body, ...footer);
    d.addEventListener('wa-after-hide', e => { if (e.target === d) d.remove(); });
    document.body.append(d);
    d.open = true;
    return d;
}
function help() {
    const dl = el('dl', 'keys-help');
    dl.append(...SHORTCUTS.flatMap(([k, what]) => [el('dt', null, k), el('dd', null, what)]));
    dialog('Keyboard shortcuts', dl);
}
// The action types into the user's Claude session, so it asks first, showing the message; the dialog itself has focus,
// so a stray Enter or a second a does nothing, and only a click (or Tab to Send) sends.
function confirmAction(x) {
    const cancel = el('wa-button', null, 'Cancel'), go = el('wa-button', null, `Send "${x.action.label}"`);
    cancel.slot = go.slot = 'footer';
    cancel.setAttribute('size', 's'); cancel.setAttribute('appearance', 'outlined');
    go.setAttribute('size', 's'); go.setAttribute('variant', 'brand');
    const body = el('div');
    body.append('Sends this to the item\'s Claude session:', el('pre', 'keys-msg', x.action.message));
    const d = dialog(`${x.action.label}?`, body, [cancel, go]);
    cancel.onclick = () => { d.open = false; };
    go.onclick = () => { d.open = false; rowOf(x.key)?.querySelector('.act-btn')?.click(); }; // the button's own path: cooldown, chat binding
}

function onKey(e) {
    const path = e.composedPath();
    if (menuOpen(path)) return;
    if (typing(path)) {
        if (e.key === 'Escape') { document.activeElement?.blur(); rowOf(focusKey)?.focus({ preventScroll: true }); }
        return;
    }
    const action = keyAction(e, Date.now() - prevAt < 1500 ? prev : null);
    prev = e.key; prevAt = Date.now();
    if (!action) return;
    // Enter/Space on a link or button inside the page keep their native meaning
    if (action === 'toggle' && e.target !== document.body && !e.target.matches?.(ROWS)) return;
    const x = itemOf(focusKey), card = focusKey?.startsWith('issue:') ? rowOf(focusKey) : null;
    const run = {
        next: () => focusRow(stepKey(rows().map(r => r.dataset.key), focusKey, 1)),
        prev: () => focusRow(stepKey(rows().map(r => r.dataset.key), focusKey, -1)),
        toggle: () => (card ? card.click() : x && rowOf(x.key) && select(x)),
        open: () => (card ? window.open(card.dataset.url, '_blank', 'noopener') : x?.pr && window.open(x.pr, '_blank', 'noopener')),
        act: () => x?.action && x.sessionId && rowOf(x.key)?.querySelector('.act-btn') && confirmAction(x),
        chat: () => $('msg').focus(),
        escape: () => { if (activeTab() === 'issues') collapseIssue(); else if (state.selected) { state.selected = null; renderBoard(); } },
        work: () => showTab('work'),
        issues: () => showTab('issues'),
        help,
        project: () => { const p = $('project'); p.focus(); p.open = true; },
        milestone: () => { const m = document.querySelector('.ms-pick:not([hidden])'); if (m) { m.open = true; m.querySelector('summary').focus(); } },
        refresh: () => hooks.refresh(),
        g: () => {}
    }[action];
    run();
    e.preventDefault();
}

export function initKeys() {
    hooks.rendered = syncRows;
    document.addEventListener('focusin', e => { const r = e.target.closest?.(ROWS); if (r) focusKey = r.dataset.key; });
    document.addEventListener('keydown', onKey);
}
