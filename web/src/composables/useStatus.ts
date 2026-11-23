import { computed, toRef } from 'vue';
import { chatStatus, ctxLevel, NEEDS_ANSWER } from '@/lib/chat';
import { oldState } from '@/old';
import { useChat } from './useChat';

/** The status line of the open chat (working, asking, stuck, idle, can't reach Homebase) and its context window use. */
export function useStatus() {

    const { session, turn, jumpToNeeds } = useChat();
    const status = computed(() => (turn.value === undefined ? { kind: 'idle', text: 'Connecting…' } : chatStatus(turn.value, undefined, session.value, oldState.value.serverError)));
    // "Claude needs your answer" is a button to the question; whatever follows it stays text
    const needsAnswer = toRef(() => status.value.kind === 'idle' && status.value.text.startsWith(NEEDS_ANSWER));

    return {
        status, needsAnswer, jumpToNeeds, NEEDS_ANSWER,
        /** amber from 60%, red from 85% */
        contextLevel: toRef(() => ctxLevel(session.value?.context ?? 0)),
        context: toRef(() => (session.value?.context != null ? `${Math.round(session.value.context)}%` : ''))
    };
}
