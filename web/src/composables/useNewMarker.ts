import { store } from 'old/core.js';
import { chatSession, refreshChat } from 'old/chat.js';

let away = false; // the window lost focus or was hidden; back on focus

/**
 * "New since you looked": leaving the window marks the time per chat (kept while an older mark is unread, i.e. the
 * feed is scrolled up); the feed draws a New divider above the first later item, gone once you're back at the bottom.
 */
export function useNewMarker() {

    const leave = (atBottom: boolean) => {
        const s = chatSession();
        if (s && (!store.get(`last-seen:${s.id}`) || atBottom)) {
            store.set(`last-seen:${s.id}`, String(Date.now()));
        }
        away = true;
    };
    const back = () => { away = false; };
    /** The reader scrolled to the bottom: the mark goes, unless they are away. */
    const caughtUp = () => {
        const s = chatSession();
        if (!away && s && store.get(`last-seen:${s.id}`)) {
            store.set(`last-seen:${s.id}`, '');
            refreshChat();
        }
    };

    return { leave, back, caughtUp };
}
