import { toRef } from 'vue';
import { inView } from 'old/core.js';
import { oldState } from '@/old';

/** The polled chats (GET /api/sessions), and those in the board's view: tracked, in the picked project. */
export function useSessions() {

    // getter refs, not computed: each read goes back to oldState, so a bump always reaches it (web/README.md)
    const sessions = toRef(() => oldState.value.sessions);
    const visible = toRef(() => oldState.value.sessions.filter(inView));

    return { sessions, visible };
}
