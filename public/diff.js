// The Changes view's old-page side (GET /api/diff, server/diff.mjs; read-only). The panel and the chat header's button
// are Vue islands (web/src/islands/Diff.vue and DiffButton.vue): this file puts them into the page.
import { el, hooks, vue } from './core.js';

// Resolves to the unmount, or to null when web/ isn't built.
/** @param {string} name @param {HTMLElement} host @param {object} [props] @returns {Promise<(() => void) | null>} */
const mount = (name, host, props) => vue.load().then(m => m?.mount(name, host, props) ?? null);

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
