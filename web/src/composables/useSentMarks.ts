import { reactive } from 'vue';
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

    if (rebasing.has(x.key)) {
        return { ...x, column: 'doing', next: 'Rebasing on GitLab…', action: null };
    }

    if (queueing.get(x.key) === true) {
        return { ...x, column: 'doing', next: 'Queued to merge…', action: { label: 'Unqueue', kind: 'unqueue', message: 'Take this MR out of the merge queue.' } };
    }

    if (starting.has(x.key)) {
        return { ...x, column: 'doing', next: 'Sent to a helper…', action: null };
    }

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

const rebasing = reactive(new Set<string>()); // rows GitLab is rebasing (POST /api/rebase in flight)

/** Rebase of an MR that is only behind: GitLab does it; when it can't, the row says why and the chat gets the usual message. */
async function rebase(x: WorkItem) {

    if (rebasing.has(x.key)) {
        return;
    }
    rebasing.add(x.key);
    let why = '';
    try {
        const r = await api(`/api/rebase?key=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null);
        why = r?.ok ? '' : r ? await r.text() : 'Couldn’t reach Homebase to rebase';
    } finally {
        rebasing.delete(x.key);
    }
    if (why) {
        useNotice().showError(x.sessionId ? `${why} — asking Claude to rebase it` : why);
        x.sessionId && await send({ ...x, action: { ...x.action!, kind: undefined } });
    }
    await hooks.refresh();
}

const starting = reactive(new Set<string>()); // rows whose helper start (POST /api/action) is in flight: shown as sent to a helper at once

/** Rebase / Fix pipeline / Fix & reply: Homebase starts a fresh helper on the MR's branch (POST /api/action); a second click opens the running one. */
async function startHelper(x: WorkItem) {

    if (starting.has(x.key)) {
        return;
    }
    starting.add(x.key);
    try {
        const r = await api(`/api/action?key=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to start the helper');
        } else {
            const out = await r.json();
            if (out.existing) {
                bindChat(out.id);
            }
        }
        await hooks.refresh();
    } finally {
        starting.delete(x.key);
    }
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

const queueing = reactive(new Map<string, boolean>()); // rows whose queue POST is in flight -> true for Merge: the row shows queued at once, and goes back if the POST fails

/** Merge / Unqueue: puts the MR in Homebase's merge queue (on) or takes it out (POST /api/queue); Merge shows the row queued before the POST answers, the poll's row takes over after it. */
async function queue(x: WorkItem, on: boolean) {

    if (queueing.has(x.key)) {
        return;
    }
    queueing.set(x.key, on);
    try {
        // the head the row showed when Merge was clicked: the server refuses if the MR moved since
        const r = await api(`/api/queue?key=${encodeURIComponent(x.key)}&on=${on ? 1 : 0}&sha=${encodeURIComponent(x.prState?.sha ?? '')}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to queue the merge');
        }
        await hooks.refresh();
    } finally {
        queueing.delete(x.key);
    }
}

/** Sends the row's one-click command to its session; the row turns into an in-progress one at once, so it can't be sent twice. */
async function send(x: WorkItem) {

    if (x.action?.kind === 'rebase') {
        return rebase(x);
    }
    if (x.action?.kind === 'unqueue') {
        return queue(x, false);
    }
    if (x.action?.kind === 'helper') {
        return startHelper(x);
    }
    if (x.action?.kind === 'review') {
        return startReview(x);
    }
    if (x.action?.kind === 'reviewing') {
        return;
    }
    if (sent.has(x.key) || !x.action) {
        return;
    }
    if (x.action.kind !== 'findings') { // findings are no hold here either: the row stays where the server puts it
        sent.set(x.key, Date.now());
        save();
    }
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
    const press = (x: WorkItem, tapped: boolean) => (x.action?.kind === 'merge' ? queue(x, true)
        : tapped && touch() ? confirmAction(x as WorkItem & { action: RowAction }) : send(x));

    return { optimistic, press, noReply };
}
