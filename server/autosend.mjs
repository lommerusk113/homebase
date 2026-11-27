// Homebase's own sends into a chat (auto-retry, merge-queue fixes): typed through control.mjs's send(), registered by server.mjs at
// start (control.mjs imports sessions.mjs, which uses this, so it can't import control.mjs). Each text is logged as a housekeeping
// send first, so the feed, reports and holds see it as Homebase's own, not the user's answer. Without a sender (tests) nothing is sent.
import { logHousekeeping } from './sendlog.mjs';

let sender = null;

export const setAutoSender = fn => { sender = fn; };
export const canAutoSend = () => !!sender;

/** Types text into the chat with a canned (button-like) send: an open question is refused, not declined. Rejects when it can't. */
export async function autoSend(sessionId, text) {

    if (!sender) {
        throw new Error('no sender registered');
    }
    logHousekeeping(sessionId, text);

    return sender(sessionId, text);
}
