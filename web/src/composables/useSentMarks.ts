import { chatSession, bindChat, sendText } from 'old/chat.js';
import { renderBoard } from 'old/list.js';
import { confirmAction } from 'old/keys.js';
import { touch } from 'old/core.js';

// Optimistic "sent" marks: item key -> click time, in memory and sessionStorage, until the server reports the item
// requested or doing, or SENT_MS pass without that (then the button comes back with a hint).
const SENT_MS = 120_000;
const sent = new Map<string, number>((() => {
    try {
        return JSON.parse(sessionStorage.getItem('sent') ?? 'null') ?? [];
    } catch {
        return [];
    }
})());
const unanswered = new Map<string, string | undefined>(); // key -> action label whose mark timed out
const save = () => {
    try {
        sessionStorage.setItem('sent', JSON.stringify([...sent]));
    } catch {}
};

/** The row as the board shows it: in Doing as "Sent to Claude…" while its mark is fresh. */
function optimistic(x: WorkItem, now = Date.now()): WorkItem {

    const at = sent.get(x.key);
    if (at == null) {
        return x;
    }
    if (x.requested || x.column === 'doing' || now - at > SENT_MS) {
        sent.delete(x.key);
        save();
        if (!x.requested && x.column !== 'doing') {
            unanswered.set(x.key, x.action?.label);
        }

        return x;
    }

    return { ...x, sent: at, column: 'doing', next: 'Sent to Claude…' };
}

/** Sends the row's one-click command to its session; the row turns into an in-progress one at once, so it can't be sent twice. */
async function send(x: WorkItem) {

    if (sent.has(x.key) || !x.action) {
        return;
    }
    sent.set(x.key, Date.now());
    save();
    unanswered.delete(x.key);

    if (x.sessionId !== chatSession()?.id) {
        bindChat(x.sessionId);
    } else {
        renderBoard();
    }
    setTimeout(renderBoard, SENT_MS + 500);

    // a failed send drops the sent mark; sendText shows the error
    if (!await sendText(x.sessionId, x.action.message, undefined, undefined, true)) {
        sent.delete(x.key);
        save();
        renderBoard();
    }
}

/** The board's one-click commands: their optimistic marks, and whether one went unanswered. */
export function useSentMarks() {

    const noReply = (x: WorkItem) => !!x.action && !x.sent && !x.requested && unanswered.get(x.key) === x.action.label;

    // On a touch screen the tooltip with the message never shows and a thumb can miss the row, so a tap asks first
    // (the dialog of the a key); its Send clicks the button from script, which is not a tap.
    const press = (x: WorkItem, tapped: boolean) => (tapped && touch() ? confirmAction(x as WorkItem & { action: RowAction }) : send(x));

    return { optimistic, press, noReply };
}
