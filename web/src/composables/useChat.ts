import { ref, shallowRef, toRef } from 'vue';
import { composer } from 'old/core.js';
import { activeHelper, chatSession, startingTarget, refreshChat, jumpToNeeds } from 'old/chat.js';
import { oldState } from '@/old';

/** What a refresh of the open chat found: its transcript, a failed poll, or null with no chat. undefined: none yet. */
export type Turn = (Partial<Transcript> & { error?: boolean }) | null | undefined;

const turn = shallowRef<Turn>();
// The chat whose pane may show a dialog its transcript doesn't ask (Claude's "Switch model?" after a /model pick): set by
// a pick and by a send refused for it, so the ask card shows it; cleared once the pane shows none.
const dialogOn = ref<string | null>(null);
composer.turn = data => { turn.value = data; };

/** The chat in the pane (old chat.js picks it and refreshes it), where a message goes, and what its last refresh found. */
export function useChat() {

    const session = toRef(() => (oldState.value, chatSession()));
    // a project that is still starting has no session id, only its tmux name
    const target = toRef(() => session.value?.id ?? (oldState.value, startingTarget()));

    // set while the pane shows a helper's own conversation: the chat is the one that started it
    const helper = toRef(() => (oldState.value, activeHelper()));

    return { session, target, helper, turn, dialogOn, refresh: () => { refreshChat(); }, jumpToNeeds };
}
