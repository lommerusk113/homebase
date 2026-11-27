// Keyboard navigation over work-item rows (after Contado): j/k move, Enter/Space expand, o opens the MR, a runs the row action.
// The same j/k/Enter/o work on the Issues view's cards; 1 and 2 pick Work or Issues and t swaps them; l opens the activity log; n steps through the chats waiting on you; a digit picks the numbered option of the question open in the chat; [ and ] cycle projects.
// The focused row is tracked by item key, so it survives the 3s re-renders; list.js and issues.js call hooks.rendered after each one.
import { $, el, waButton, state, store, hooks, plainKeysOff } from './core.js';
import { select, renderBoard } from './list.js';
import { openOptions, focusQuestionOf } from './chat.js';
import { showTab, activeTab, collapseIssue } from './issues.js';
import { openLog } from './log.js';

const SHORTCUTS = [
    ['d', 'Changes (diff) of the open chat; j / k move between its files'],
    ['j / ↓', 'Next item'], ['k / ↑', 'Previous item'], ['Enter / Space', 'Expand or collapse, chat with its session'],
    ['o', 'Open the MR or PR in a new tab'], ['a', "Run the row's action (asks first)"], ['/ or c', 'Focus the chat input'],
    ['Esc', 'Leave the input, or collapse the row'], ['n', 'Next chat waiting on you'], ['1 – 9', 'Pick that option of the question open in the chat'], ['1 / 2', 'Work / Issues, when no question is open'], ['t', 'Swap Work and Issues'], ['l', 'Activity log'],
    ['[ / ]', 'Previous / next project'], ['g then p', 'Project selector'], ['m', 'Milestone menu'], ['r', 'Refresh from GitLab/GitHub'], ['?', 'This overlay']
];
const KEYS = { j: 'next', ArrowDown: 'next', k: 'prev', ArrowUp: 'prev', Enter: 'toggle', ' ': 'toggle', o: 'open', a: 'act', '/': 'chat', c: 'chat', Escape: 'escape', '?': 'help', m: 'milestone', r: 'refresh', g: 'g', n: 'needs', '[': 'prevProject', ']': 'nextProject', 1: 'work', 2: 'issues', t: 'swap', l: 'log' };

// Action for a keydown ({ key, metaKey, ctrlKey, altKey }); prev is 'g' when g was pressed just before.
/** @param {Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>} e @param {string | null} prev @returns {string | null} */
export function keyAction(e, prev) {
    if (e.metaKey || e.ctrlKey || e.altKey) {
        return null;
    }
    if (prev === 'g' && e.key === 'p') {
        return 'project';
    }
    return KEYS[e.key] ?? null;
}

// Key after (dir 1) or before (dir -1) current among the visible keys; clamps at the ends, starts at an end when current is gone.
/** @param {string[]} keys @param {string | null} current @param {number} dir @returns {string | null} */
export function stepKey(keys, current, dir) {
    if (!keys.length) {
        return null;
    }
    const i = keys.indexOf(current);
    if (i < 0) {
        return dir > 0 ? keys[0] : keys.at(-1);
    }
    return keys[Math.max(0, Math.min(keys.length - 1, i + dir))];
}

// The project after (dir 1) or before (dir -1) current, wrapping around; from "All" (not in the list) it starts at an end.
/** @param {string[]} list @param {string} current @param {number} dir @returns {string | null} */
export function cycleProject(list, current, dir) {
    if (!list.length) {
        return null;
    }
    const i = list.indexOf(current);
    return list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
}

KEYS.d = 'diff';
let focusKey = null, prev = null, prevAt = 0;
const ROWS = '#masters tr[data-key], #issues .card[data-key]'; // work rows and issue cards; the hidden view's are skipped below
/** @returns {HTMLElement[]} */
const rows = () => [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ROWS))].filter(r => r.checkVisibility()); // skips the folded Merged group
const rowOf = key => rows().find(r => r.dataset.key === key);
/** @param {string | null} key @returns {WorkItem | undefined} */
const itemOf = key => state.sessions.flatMap(s => s.items || []).find(x => x.key === key);
const typing = path => path.some(n => n.isContentEditable || ['input', 'textarea', 'wa-input', 'wa-textarea'].includes(n.localName));
const menuOpen = path => !!document.querySelector('wa-dialog[open], wa-dropdown[open], details.ms-pick[open], .pp.open')
    || path.some(n => ['wa-dialog', 'wa-dropdown'].includes(n.localName) || n.classList?.contains('ms-pick') || n.classList?.contains('pp'));

// Roving tabindex and ARIA state on the rows; refocus puts DOM focus back on the tracked row after a re-render took it away.
function syncRows(refocus) {
    const all = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(ROWS))], cur = all.find(r => r.dataset.key === focusKey), first = cur || rows()[0];
    all.forEach(r => {
        r.tabIndex = r === first ? 0 : -1;
        r.setAttribute('aria-selected', r === cur);
        if (r.localName === 'tr') {
            r.setAttribute('aria-expanded', r.dataset.key === state.selected);
        }
    });
    if (refocus && cur) {
        cur.focus({ preventScroll: true });
    }
}

// Focus fell to <body> (a dialog or the changes panel closed over a row that was redrawn meanwhile): back to the tracked row.
function refocus() {
    if (!document.activeElement || document.activeElement === document.body) {
        syncRows(true);
    }
}

function focusRow(key) {
    const r = key && rowOf(key);
    if (!r) {
        return;
    }
    focusKey = key;
    syncRows();
    r.focus({ preventScroll: true });
    r.scrollIntoView({ block: 'nearest' });
}

function dialog(label, body, footer = []) {
    const d = el('wa-dialog');
    d.setAttribute('label', label);
    d.setAttribute('light-dismiss', '');
    d.append(body, ...footer);
    d.addEventListener('wa-after-hide', e => {
        if (e.target === d) {
            d.remove();
            refocus(); // the row it was opened from may have been redrawn meanwhile
        }
    });
    document.body.append(d);
    d.open = true;
    return d;
}
function help() {
    const dl = el('dl', 'keys-help');
    dl.append(...SHORTCUTS.flatMap(([k, what]) => [el('dt', null, k), el('dd', null, what)]));
    // WCAG 2.1.4: single-character shortcuts can be turned off (they collide with screen reader and speech input keys)
    const toggle = el('label', 'keys-toggle'), box = el('input');
    box.type = 'checkbox';
    box.checked = store.get('keys') !== 'off';
    box.onchange = () => store.set('keys', box.checked ? 'on' : 'off');
    toggle.append(box, 'Letter, number and symbol shortcuts. Off: only Enter, Space, the arrows, Esc and ? work.');
    dialog('Keyboard shortcuts', dl, [toggle]);
}
// The action types into the user's Claude session, so it asks first, showing the message; the dialog itself has focus,
// so a stray Enter or a second a does nothing, and only a click (or Tab to Send) sends.
/** @param {{ key: string, action: { label: string, message: string, kind?: string } }} x */
export function confirmAction(x) {
    const btn = /** @type {HTMLElement | null} */ (rowOf(x.key)?.querySelector('.act-btn'));
    if (['merge', 'rebase', 'unqueue'].includes(x.action.kind ?? '')) {
        return btn?.click(); // the button asks itself
    }
    const cancel = waButton('Cancel'), go = waButton(`Send "${x.action.label}"`, null, { variant: 'brand', appearance: 'accent' });
    cancel.slot = go.slot = 'footer';
    const body = el('div');
    body.append('Sends this to the item\'s Claude session:', el('pre', 'keys-msg', x.action.message));
    const d = dialog(`${x.action.label}?`, body, [cancel, go]);
    cancel.onclick = () => { d.open = false; };
    go.onclick = () => { d.open = false; btn?.click(); }; // the button's own path: sent mark, chat binding
}

/** @param {number} dir */
function cycle(dir) {
    const list = [...state.tracked].sort((a, b) => a.localeCompare(b));
    const next = cycleProject(list.length > 1 ? [...list, 'all'] : list, state.project, dir); // "All my projects" is one stop on the way round
    if (next) {
        hooks.setProject(next);
    }
}

/** @param {KeyboardEvent} e */
function onKey(e) {
    const path = e.composedPath();
    if (menuOpen(path)) {
        return;
    }
    if (typing(path)) {
        if (e.key === 'Escape') { /** @type {HTMLElement | null} */ (document.activeElement)?.blur(); rowOf(focusKey)?.focus({ preventScroll: true }); }
        return;
    }
    if (plainKeysOff(e)) {
        return;
    }
    // a question's number badges are its keys while it is open in the chat; the views keep t
    const opts = /^[1-9]$/.test(e.key) && !(e.metaKey || e.ctrlKey || e.altKey) ? openOptions() : [];
    if (opts.length) {
        opts.find(b => b.querySelector('.k')?.textContent === e.key && !b.hasAttribute('disabled'))?.click();
        e.preventDefault();
        return;
    }
    const action = keyAction(e, Date.now() - prevAt < 1500 ? prev : null);
    prev = e.key;
    prevAt = Date.now();
    if (!action) {
        return;
    }
    // Enter/Space on a link or button inside the page keep their native meaning
    if (action === 'toggle' && e.target !== document.body && !/** @type {Element} */ (e.target).matches?.(ROWS)) {
        return;
    }
    const x = itemOf(focusKey), card = /^(issue|session|asking|starting|working|review):/.test(focusKey ?? '') ? rowOf(focusKey) : null;
    const run = {
        next: () => focusRow(stepKey(rows().map(r => r.dataset.key), focusKey, 1)),
        prev: () => focusRow(stepKey(rows().map(r => r.dataset.key), focusKey, -1)),
        toggle: () => {
            // opening a waiting chat by keyboard: its question takes the focus once it is drawn. Only the chat's own
            // row: an item row of the same session may be about something else than the question on screen.
            if (focusKey?.startsWith('asking:')) {
                focusQuestionOf(focusKey.slice(7));
            }
            return card ? card.click() : x && rowOf(x.key) && select(x);
        },
        open: () => (card ? card.dataset.url && window.open(card.dataset.url, '_blank', 'noopener') : x?.pr && window.open(x.pr, '_blank', 'noopener')),
        act: () => (card?.dataset.msg
            ? card.querySelector('.act-btn:not([disabled])') && confirmAction({ key: focusKey, action: { label: card.dataset.label, message: card.dataset.msg } })
            : x?.action && (x.sessionId || ['merge', 'rebase', 'unqueue'].includes(x.action.kind ?? '')) && rowOf(x.key)?.querySelector('.act-btn') && confirmAction(x)),
        chat: () => $('msg').focus(),
        escape: () => {
            if (activeTab() === 'issues') {
                collapseIssue();
            } else if (state.selected) {
                state.selected = null;
                renderBoard();
            }
        },
        work: () => showTab('work'),
        issues: () => showTab('issues'),
        swap: () => showTab(activeTab() === 'work' ? 'issues' : 'work'),
        log: openLog,
        help,
        diff: () => $('c-diff')?.click(),
        project: () => {
            hooks.openProjects();
        },
        milestone: () => {
            const m = /** @type {HTMLDetailsElement | null} */ (document.querySelector('.ms-pick:not([hidden])'));
            if (m) {
                m.open = true;
                m.querySelector('summary').focus();
            }
        },
        refresh: () => hooks.refresh(),
        needs: () => {
            if (activeTab() !== 'work') {
                showTab('work');
            }
            const waiting = rows().map(r => r.dataset.key).filter(k => k.startsWith('asking:'));
            focusRow(waiting[(waiting.indexOf(focusKey) + 1) % waiting.length]); // the one after the focused one, around
        },
        prevProject: () => cycle(-1),
        nextProject: () => cycle(1),
        g: () => {}
    }[action];
    run();
    e.preventDefault();
}

export function initKeys() {
    hooks.rendered = syncRows;
    hooks.refocus = refocus;
    document.addEventListener('focusin', e => {
        const r = /** @type {HTMLElement | null} */ (e.target instanceof Element ? e.target.closest(ROWS) : null);
        if (r) {
            focusKey = r.dataset.key;
        }
    });
    document.addEventListener('keydown', onKey);
}
