import { api, state } from 'old/core.js';
import { refreshChat } from 'old/chat.js';
import { useSend } from '@/composables/useSend';

const LANDED_SLACK_MS = 10_000; // a transcript item may predate the send it matches by this much
const OUTBOX_TTL_MS = 30_000; // after a successful send, a bubble nothing matched by then is marked not confirmed

// same unwrap as the server's unwrapPasted, plus whitespace collapsed, for matching sent text to transcript text
const norm = (t?: string) => (t || '').replace(/<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content(?: id="\1")?>/g, '$2').replace(/\s+/g, ' ').trim();
const tooEarly = (at: string | undefined, o: OutboxItem) => Date.parse(at ?? '') < Date.parse(o.at) - LANDED_SLACK_MS;

/** Whether the transcript's items hold what an outbox item sent: its text, or the text plus its unshown note. */
export function landedIn(items: ChatItem[], o: OutboxItem): boolean {

    const sameSend = (text?: string, at?: string) => [o.text, o.note && `${o.text}\n\n${o.note}`].some(t => t && norm(text) === norm(t)) && !tooEarly(at, o);

    return items.some(i => (i.role === 'user' && sameSend(i.text, i.at))
        || (i.role === 'command' && sameSend(i.cmd, i.at)) // a slash command whose output the transcript now holds
        || (i.role === 'compact' && /^\/compact\b/.test(o.text) && !tooEarly(i.at, o)) // a /compact is its divider
        || (!!i.answer && sameSend(i.answer.text, i.answer.at)));
}

/**
 * Drops a chat's optimistic bubbles the transcript now has (it is the source of truth), and marks as not confirmed
 * (Retry / Dismiss) those nothing matched OUTBOX_TTL_MS after their send succeeded, rather than letting them vanish.
 */
export function pruneOutbox(sid: string, items: ChatItem[]): void {

    state.outbox = state.outbox.filter(o => o.sid !== sid || o.error || !landedIn(items, o));
    // a slash command with no output in the transcript never shows there: once sent it stays, with its result; so does an
    // answer typed into a question's text box, unless the transcript shows it as that question's answer
    for (const o of state.outbox) {
        o.unconfirmed ||= o.sid === sid && !o.text.startsWith('/') && !o.answered && Date.now() - (o.okAt ?? NaN) > OUTBOX_TTL_MS;
    }
}

// The same as landedIn, read fresh from the server: before Retry sends a not confirmed message again. Throws when it can't be read.
async function arrived(o: OutboxItem): Promise<boolean> {

    const s = state.sessions.find(x => x.id === o.sid);
    if (!s) {
        return false; // a chat still starting has no transcript to ask
    }
    const r = await api(`/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}`);
    if (!r.ok) {
        throw new Error(await r.text());
    }

    return landedIn((await r.json()).items, o);
}

/** A user bubble's status under it, and what its buttons do. */
export function useOutbox() {

    const { send, showError, focusComposer, forgetGivenBack } = useSend();

    /** The outbox item behind a bubble that failed or is not confirmed, else null. */
    const lostOf = (i: ChatItem): OutboxItem | null => {
        const o = i as OutboxItem;
        return o.unconfirmed || (i.error && state.outbox.includes(o)) ? o : null;
    };
    /** "Not sent", "Not confirmed", "sending…" or "queued", else null. */
    const noteOf = (i: ChatItem): string | null => (i.error ? `Not sent${(i as OutboxItem).refused ? `: ${i.error}` : ''}`
        : lostOf(i) ? 'Not confirmed — Claude may not have received this' : i.sending ? 'sending…' : i.pending ? 'queued' : null);

    const drop = (lost: OutboxItem) => { state.outbox = state.outbox.filter(o => o !== lost); };
    const retry = async (lost: OutboxItem, e: Event) => {
        if (lost.unconfirmed) { // it may have arrived after all: look before sending a second copy
            try {
                if (await arrived(lost)) {
                    return void refreshChat(); // which drops the bubble for the transcript's own
                }
            } catch {
                return showError('Couldn’t check whether this arrived, so it was not sent again. Try Retry once Homebase answers.');
            }
        }
        drop(lost);
        forgetGivenBack(lost);
        focusComposer(e);
        send(lost.sid, lost.text, lost.answerTo, lost.note, lost.canned);
    };
    const dismiss = (lost: OutboxItem, e: Event) => {
        drop(lost);
        focusComposer(e);
        refreshChat();
    };
    /** Interrupts Claude's current step so a queued message (key `<sid>:<at>`) is handled now; it shows "sending…" meanwhile. */
    const sendNow = async (sid: string, key: string) => {
        state.nudged.add(key);
        showError('');
        refreshChat();
        try {
            const r = await api(`/api/interrupt?id=${encodeURIComponent(sid)}`, { method: 'POST' });
            if (!r.ok) {
                throw new Error(await r.text());
            }
        } catch (err) {
            state.nudged.delete(key);
            showError((err as Error).message);
            refreshChat();
        }
    };

    return { lostOf, noteOf, retry, dismiss, sendNow };
}
