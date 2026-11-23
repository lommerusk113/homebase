// The Changes view's old-page side (GET /api/diff, server/diff.mjs; read-only). The panel and the chat header's button
// are Vue islands (web/src/islands/Diff.vue and DiffButton.vue): this file puts them into the page, and still draws
// the old board's row icon.
import { api, el, waButton, hooks, vue } from './core.js';

// These islands are styled by styles.css alone, so .hb-island comes off again: inside it shadcn's tokens (--muted,
// --accent, ...) replace the page's own of the same names. Resolves to the unmount, or to null when web/ isn't built.
/** @param {string} name @param {HTMLElement} host @param {object} [props] @returns {Promise<(() => void) | null>} */
const mount = (name, host, props) => vue.load().then(m => {
    const unmount = m?.mount(name, host, props) ?? null;
    host.classList.remove('hb-island');
    return unmount;
});

// The panel is modal: the page behind it takes no focus and is not read while it is open. The dialogs and the
// live region (#announce) stay as they are.
/** @param {boolean} inert */
const behind = inert => document.querySelectorAll('header.top, .main, #ptabs').forEach(n => { /** @type {HTMLElement} */ (n).inert = inert; });

/** @type {{ host: HTMLElement, back: Element | null, unmount: (() => void) | null } | null} */
let panel = null;

// Opens the panel for a session's folder, or with item (a work item's key) for that item's worktree.
/** @param {string} sid @param {string | null} [item] */
export function openDiff(sid, item = null) {
    if (panel) { // modal: nothing behind it can ask for another
        return;
    }
    const mine = panel = { host: el('div'), back: document.activeElement, unmount: null };
    document.body.append(mine.host);
    behind(true);
    mount('Diff', mine.host, { sid, item }).then(unmount => {
        if (panel !== mine) { // closed before it was up
            unmount?.();
        } else if (unmount) {
            mine.unmount = unmount;
        } else {
            closeDiff();
        }
    });
}

export function closeDiff() {
    if (!panel) {
        return;
    }
    const { host, back, unmount } = panel;
    panel = null;
    unmount?.();
    host.remove();
    behind(false);
    if (back instanceof HTMLElement && back.isConnected) {
        back.focus({ preventScroll: true });
    } else {
        hooks.refocus?.(); // the row it was opened from was redrawn meanwhile
    }
}

// A work row's "Changes" icon, only when its helper's worktree (or the worktree that has its branch checked out) has
// changes; never the chat's folder, which would show unrelated changes. Each row's count is read when the row is drawn and at most every
// COUNT_MS after, never on the poll itself; a count that changes redraws the board.
// ponytail: the old board's own copy of useRowDiffCount (web/src/composables/useDiffCounts.ts); it goes when the
// ported board draws web/src/components/DiffIcon.vue instead.
const COUNT_MS = 15_000;
const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 6.5v7M8.5 10h7M8.5 17h7"/></svg>';
/** @type {Map<string, { at: number, n: number }>} item key -> changed files */
const rowCounts = new Map();
/** @param {WorkItem} x @returns {Promise<number>} */
async function changedFiles(x) {
    const r = await api(`/api/diff?${new URLSearchParams({ session: x.sessionId, item: x.key })}`);
    if (!r.ok) {
        throw new Error(await r.text());
    }
    /** @type {DiffView} */
    const v = await r.json();
    return v.repo ? new Set([...v.uncommitted, ...v.committed].map(f => f.path)).size : 0;
}
/** @param {WorkItem} x @param {() => void} redraw @returns {HTMLElement[]} */
export function diffIcon(x, redraw) {
    if (!(x.worktreePath || x.branch) || !x.sessionId) {
        return [];
    }
    const hit = rowCounts.get(x.key), was = hit?.n ?? 0;
    if (!document.hidden && (!hit || Date.now() - hit.at >= COUNT_MS)) {
        rowCounts.set(x.key, { at: Date.now(), n: was }); // one fetch at a time per row
        changedFiles(x).then(n => {
            rowCounts.set(x.key, { at: Date.now(), n });
            if (n !== was) {
                redraw();
            }
        }, () => {});
    }
    if (!was) {
        return [];
    }
    const b = waButton('', 'act-btn dv-row', { appearance: 'plain', 'aria-label': 'Changes', title: 'Changes' });
    b.innerHTML = ICON;
    b.onclick = e => {
        e.stopPropagation();
        openDiff(x.sessionId, x.key);
    };
    return [b];
}

// The chat's corner "±" (Changes) button: the DiffButton island at the end of the chat's top strip, mounted once. It
// reads the shown chat from chatHead (useChatDiffCount in web/src/composables/useDiffCounts.ts) after the bump.
export const chatHead = { session: /** @type {Session | null} */ (null), mounted: false };
/** @param {Session | null} s */
export function syncDiff(s) {
    chatHead.session = s;
    if (!chatHead.mounted) {
        chatHead.mounted = true;
        mount('DiffButton', document.querySelector('#chat .c-head').appendChild(el('span', 'c-diff-slot')));
    }
    vue.bump();
}
