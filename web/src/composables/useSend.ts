import { api, state, friendly, composer } from 'old/core.js';
import { cannedLabel } from 'old/canned.js';
import { answered, stickFeed } from 'old/chat.js';
import { useChat } from './useChat';
import { useComposerFocus } from './useComposerFocus';
import { useDraft } from './useDraft';
import { useNotice } from './useNotice';

const SEND_TIMEOUT_MS = 45_000; // past control.mjs BOOT_MS: a chat that has to start first isn't "Not sent" while it still goes through

/** Sending a message to a chat, with the outbox entry the feed shows until the transcript has it, and the composer's error line and focus. */
export function useSend() {

    const { target, dialogOn, refresh } = useChat();
    const { error, showError } = useNotice();
    const { focus } = useComposerFocus();
    const draft = useDraft();
    // the error line says it only while the box is still this chat's, not another one switched to meanwhile
    const tell = (sid: string, msg: string) => {
        if ((draft.chat() ?? target.value) === sid) {
            error.value = msg;
        }
    };

    /**
     * Types text into a session as an outbox bubble ("sending…", then gone once the transcript has it); false if it failed.
     * note: appended to what is sent but not shown, so the chat shows just the label.
     * canned: a button's message, not typed by the user: the server refuses it while Claude asks, instead of declining the question.
     */
    async function send(sid: string, text: string, answerTo?: string, note?: string, canned?: boolean): Promise<boolean> {

        error.value = '';
        const out: OutboxItem = { role: 'user', text, sid, at: new Date().toISOString(), sending: true, answerTo, note, canned, ...(canned && { label: cannedLabel(text) ?? undefined }) };
        state.outbox = [...state.outbox.filter(o => !(o.error && o.sid === sid) && !(answerTo && o.answerTo === answerTo)), out];
        stickFeed();
        refresh();

        try {
            const r = await api(`/api/send?${sid.startsWith('cc-new-') ? 'tmux' : 'id'}=${encodeURIComponent(sid)}${canned ? '&canned=1' : ''}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: note ? `${text}\n\n${note}` : text, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
            if (!r.ok) {
                out.refused = r.status === 409;
                throw new Error(await r.text());
            }
            out.okAt = Date.now();
            // a slash command's panel or output (control.mjs settleCommand), shown under it as a reply
            const result: OutboxItem['result'] | null = /json/.test(r.headers.get('content-type') ?? '') ? await r.json() : null;
            if (result) {
                out.result = result;
            }
            const said = result ? result.warning ?? 'ok' : await r.text();
            out.answered = said === 'answered'; // it went into the open question's text box (control.mjs send)
            out.sending = !(out.answered || text.startsWith('/')); // those never land in the transcript as the user's: done once sent
            tell(sid, said === 'ok' || out.answered ? '' : said); // sent, with a warning (running twice)
            answered(sid);
            setTimeout(refresh, 1000);

            return true;
        } catch (e) {
            const err = e as Error;
            if (err.name === 'TimeoutError') {
                // no answer is not a refusal: the server may still type it. Not confirmed (the transcript drops the bubble
                // once it has the text, and Retry looks there first), and the text is not handed back to be sent twice.
                out.sending = false;
                out.unconfirmed = true;
                tell(sid, 'Homebase did not answer in 45 s, so this may or may not have reached Claude.');
                refresh();

                return true;
            }
            if (/typing can't answer/.test(err.message)) { // control.mjs NEEDS_CLICK: the ask card gets that dialog
                dialogOn.value = sid;
            }
            const why: string = friendly(err.message);
            out.error = why;
            tell(sid, why);
            refresh();

            return false;
        }
    }

    return {
        send,
        /** The red line above the message box ('' clears it). */
        showError,
        /** After a keyboard press on a button that is about to go away (an option, Retry, Dismiss), the composer takes the
         *  focus, which would otherwise fall to <body>. Not after a tap (a phone would raise its keyboard) or a digit key. */
        focusComposer(e: Event) {
            if ((e as MouseEvent).detail === 0 && document.activeElement === e.currentTarget) {
                focus();
            }
        },
        /** A failed send gave its text back to the box: a Retry from the bubble takes it out again, so it isn't sent twice. */
        forgetGivenBack(o: OutboxItem) {
            if (draft.text.value === o.text && (draft.chat() ?? target.value) === o.sid) {
                draft.put(o.sid, '');
            }
        }
    };
}

// the old page's buttons (row actions, the waiting strip's chips, Load rules) send through here too
composer.send = useSend().send;
