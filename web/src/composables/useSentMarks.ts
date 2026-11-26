import { chatSession, bindChat, sendText } from 'old/chat.js';
import { renderBoard } from 'old/list.js';
import { confirmAction } from 'old/keys.js';
import { touch, api, hooks } from 'old/core.js';
import { useNotice } from '@/composables/useNotice';
import { refusedAsSent } from '@/composables/useSend';

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

    return { ...x, sent: at, column: 'doing', next: `Sent to Claude (${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` };
}

const reviewing = new Set<string>(); // rows whose Review POST is in flight, so a double click starts one reviewer

/** Review: starts the row's reviewer chat (POST /api/reviewer); the row says "Reviewing…" from the next poll. */
async function startReview(x: WorkItem) {

    if (reviewing.has(x.key)) {
        return;
    }
    reviewing.add(x.key);
    try {
        const r = await api(`/api/reviewer?key=${encodeURIComponent(x.key)}&once=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null);
        if (!refusedAsSent(r, x.key) && !r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to start the reviewer');
        }
        await hooks.refresh();
    } finally {
        reviewing.delete(x.key);
    }
}

const merging = new Set<string>(); // rows whose merge POST is in flight

/** Merge: Homebase merges the approved GitLab MR (POST /api/merge); the row says Merged from the next poll. */
async function merge(x: WorkItem) {

    if (merging.has(x.key)) {
        return;
    }
    merging.add(x.key);
    try {
        const r = await api(`/api/merge?key=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to merge');
        }
        await hooks.refresh();
    } finally {
        merging.delete(x.key);
    }
}

/** Sends the row's one-click command to its session; the row turns into an in-progress one at once, so it can't be sent twice. */
async function send(x: WorkItem) {

    if (x.action?.kind === 'review') {
        return startReview(x);
    }
    if (x.action?.kind === 'reviewing') {
        return;
    }
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
    // findings are no hold: their own key keeps the double-send guard without parking the row in Doing (docs/row-states.md)
    if (!await sendText(x.sessionId, x.action.message, undefined, undefined, true, x.action.kind === 'findings' ? `findings:${x.key}` : x.key)) {
        sent.delete(x.key);
        save();
        renderBoard();
    } else if (x.action.kind === 'findings') {
        await api(`/api/reviewer/sent?key=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null); // the next Review starts a fresh reviewer
    }
}

/** The board's one-click commands: their optimistic marks, and whether one went unanswered. */
export function useSentMarks() {

    const noReply = (x: WorkItem) => !!x.action && !x.sent && !x.requested && unanswered.get(x.key) === x.action.label;

    // On a touch screen the tooltip with the message never shows and a thumb can miss the row, so a tap asks first
    // (the dialog of the a key); its Send clicks the button from script, which is not a tap.
    // Merge can't be undone, so it always asks first, click or tap
    const press = (x: WorkItem, tapped: boolean) => (x.action?.kind === 'merge' ? confirmAction(x as WorkItem & { action: RowAction }, () => merge(x))
        : tapped && touch() ? confirmAction(x as WorkItem & { action: RowAction }) : send(x));

    return { optimistic, press, noReply };
}
