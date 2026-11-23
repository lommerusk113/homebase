import { sendText, showErr, focusComposer, forgetGivenBack } from 'old/chat.js';

/** Sending to a chat, and the composer's error line and focus: the old page's own (chat.js) until the composer is ported. */
export function useSend() {

    return {
        /** Types text into a chat as an outbox bubble; false if it failed. note: sent after the text but not shown. */
        send: (sid: string, text: string, answerTo?: string, note?: string, canned?: boolean): Promise<boolean> => sendText(sid, text, answerTo, note, canned),
        /** The red line under the composer ('' clears it). */
        showError: (msg: string) => showErr(msg),
        /** After a keyboard press on a button that is about to go away, the composer takes the focus. */
        focusComposer: (e: Event) => focusComposer(e),
        /** A failed send gave its text back to the box: a Retry from the bubble takes it out again. */
        forgetGivenBack: (o: OutboxItem) => forgetGivenBack(o)
    };
}
