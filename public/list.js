// Left column: selecting a row and redrawing the board. The board itself is the Board island (web/src/islands/Board.vue);
// what its rows are made of is web/src/lib/board.ts.
import { $, state, seenAt, markSeen, updateTitle, moved, vue } from './core.js';
import { chatSession, bindChat, focusChat } from './chat.js';

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

// moved: web/src/lib/board.ts (the old chat and app code still call these)
export const sessionTopic = moved('sessionTopic');
export const attentionEvents = moved('attentionEvents');
export const askingEvents = moved('askingEvents');
