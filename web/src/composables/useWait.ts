import { shallowRef } from 'vue';
import { composer, openDecision } from 'old/core.js';
import { answerNote } from 'old/chat.js';
import { useSend } from './useSend';

/** The reply the strip is about, and what answers it. `key` changes when the strip has to show something new. */
interface Waiting { key: string; sid: string; reply: ChatItem; items: ChatItem[] }

const waiting = shallowRef<Waiting | null>(null);

// refreshChat hands over what it found: Claude's newest reply when it says something waits on the user, also after the
// user said something else. The ask card takes its place (data.asking).
composer.wait = (s, data, items) => {
    const reply = s && data && !data.asking ? openDecision({ items }) : null;
    waiting.value = s && reply ? { key: JSON.stringify([s.id, reply.at, reply.waiting, reply.replies]), sid: s.id, reply, items } : null;
};

/** The strip above the composer while a reply waits on the user: its question, what led to it, and its options as chips. */
export function useWait() {

    const { send } = useSend();

    return {
        waiting,
        /** Sends a chip's label as the answer, with a note naming the question when it isn't the newest one; false if it failed. */
        answer(label: string): Promise<boolean> {

            const w = waiting.value!;

            return send(w.sid, label, w.reply.at, answerNote(w.items, w.items.indexOf(w.reply)));
        }
    };
}
