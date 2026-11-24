// The Changes view's old-page side (GET /api/diff, server/diff.mjs; read-only). The panel and the chat header's button
// are Vue islands (web/src/islands/Diff.vue and DiffButton.vue): this file puts them into the page.
import { el, hooks, vue } from './core.js';

// Resolves to the unmount, or to null when web/ isn't built.
/** @param {string} name @param {HTMLElement} host @param {object} [props] @returns {Promise<(() => void) | null>} */
const mount = (name, host, props) => vue.load().then(m => m?.mount(name, host, props) ?? null);

// The panel sits over the board card; on a phone the board pane is hidden while the chat shows, so opening switches to
// it and closing goes back to the chat tab it came from.
/** @param {string} pane */
const pane = pane => /** @type {HTMLElement | null} */ (document.querySelector(`#ptabs button[data-pane="${pane}"]`))?.click();
const phone = () => matchMedia('(max-width: 900px)').matches;

/** @type {{ host: HTMLElement, back: Element | null, chat: boolean, unmount: (() => void) | null } | null} */
let panel = null;

// Opens the panel for a session's folder, or with item (a work item's key) for that item's worktree.
/** @param {string} sid @param {string | null} [item] */
export function openDiff(sid, item = null) {
    if (panel) { // one at a time
        return;
    }
    const chat = phone() && document.body.dataset.pane === 'chat';
    const mine = panel = { host: el('div', 'dv-host'), back: document.activeElement, chat, unmount: null };
    if (chat) {
        pane('work');
    }
    document.querySelector('.left')?.append(mine.host);
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
    const { host, back, chat, unmount } = panel;
    panel = null;
    unmount?.();
    host.remove();
    if (chat) {
        pane('chat');
    }
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
