import { focusChat } from 'old/chat.js';
import { oldState } from '@/old';
import { waitsOnYou } from '@/lib/waiting';

/** Step in on a row: a helper's own chat (one in its own tmux, or an in-process helper's conversation; Back returns to the
 *  chat that started it), or, while that chat asks a question, the chat itself at that question, which a running
 *  in-process helper's relayed question is. */
export function useStepIn() {

    const parent = (x: WorkItem) => oldState.value.sessions.find(s => s.id === x.sessionId);
    /** The chat that started a running in-process helper waits on you: it relays the helper's question. */
    const relayed = (x: WorkItem) => !x.helperSession && x.agentStatus === 'running' && !!x.agentId && !!parent(x) && waitsOnYou(parent(x)!) && !parent(x)!.askingAgent;
    /** A running helper's own question or permission prompt waits on you: step in to answer it. */
    const asking = (x: WorkItem) => {
        const own = x.helperSession && oldState.value.sessions.find(s => s.id === x.helperSession);
        return own ? waitsOnYou(own) : !!x.agentId && parent(x)?.askingAgent === x.agentId;
    };

    return {
        canStepIn: (x: WorkItem) => !!x.sessionId,
        relayed, asking,
        stepIn: (x: WorkItem) => (x.helperSession
            ? focusChat(x.helperSession)
            : relayed(x)
                ? focusChat(x.sessionId, null, x.agentDescription ?? x.title)
                : focusChat(x.sessionId, x.agentId ? { id: x.agentId, description: x.agentDescription ?? x.title } : null))
    };
}
