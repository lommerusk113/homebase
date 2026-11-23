import { store } from 'old/core.js';

interface Seen { at: number; keys: string[] }

// Needs-you bubbles stay unread (a dot) until opened or answered. needs-seen:<sid> = { at, keys }: anything at or
// before `at` counts as seen, so the first load doesn't light up every old bubble.
function seenStore(sid: string): Seen | null {
    try {
        return JSON.parse(store.get(`needs-seen:${sid}`) ?? '') || null;
    } catch {
        return null;
    }
}

/** What was seen of a chat; its first load marks everything up to its newest item as seen. */
export function seenOf(sid: string, items: ChatItem[]): Seen {

    let seen = seenStore(sid);
    if (!seen) {
        seen = { at: Date.parse(items.at(-1)?.at ?? '') || Date.now(), keys: [] };
        store.set(`needs-seen:${sid}`, JSON.stringify(seen));
    }

    return seen;
}

/** Marking a needs-you bubble (key `<sid>:<at>`) as read. */
export function useUnread() {

    const markRead = (sid: string, key: string) => {
        const v = seenStore(sid) ?? { at: 0, keys: [] };
        if (!v.keys.includes(key)) {
            store.set(`needs-seen:${sid}`, JSON.stringify({ ...v, keys: [...v.keys, key].slice(-200) }));
        }
    };

    return { markRead };
}
