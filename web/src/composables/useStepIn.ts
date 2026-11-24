import { focusChat } from 'old/chat.js';
import { oldState } from '@/old';
import { waitsOnYou } from '@/lib/waiting';

/** Step in on a row: a helper's own chat (one in its own tmux), or an in-process lookup's conversation, read-only (Back
 *  returns to the chat that started it). */
export function useStepIn() {

    const parent = (x: WorkItem) => oldState.value.sessions.find(s => s.id === x.sessionId);
    /** A chat's question about the row (askedBy), or its running helper's own question or permission prompt, waits on you: step in to answer it. */
    const asking = (x: WorkItem) => {
        if (x.askedBy) {
            return true;
        }
        const own = x.helperSession && oldState.value.sessions.find(s => s.id === x.helperSession);
        return own ? waitsOnYou(own) : !!x.agentId && parent(x)?.askingAgent === x.agentId;
    };

    return {
        canStepIn: (x: WorkItem) => !!x.sessionId,
        asking,
        stepIn: (x: WorkItem) => (x.askedBy ? focusChat(x.askedBy) : x.helperSession
            ? focusChat(x.helperSession)
            : focusChat(x.sessionId, x.agentId ? { id: x.agentId, description: x.agentDescription ?? x.title } : null))
    };
}
