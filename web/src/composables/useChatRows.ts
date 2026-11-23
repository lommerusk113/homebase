import { computed, reactive } from 'vue';
import { inView, markHandled, store } from 'old/core.js';
import { ago } from '@/lib/time';
import { waitsOnYou } from '@/lib/waiting';
import { isMaster, bindChat, focusChat } from 'old/chat.js';
import { startingIssues, sessionTopic, workingTitle, workingLine } from '@/lib/board';
import { oldState } from '@/old';

const handled = reactive(new Set<string>()); // replies marked as handled here, until the next poll has the server's word

// A main chat whose turn never ended and went silent for 30 minutes (the laptop slept, Claude hangs): without a row it
// would only vanish from Doing. It stays under Needs you until the user opens it, per turn (lastActivity).
const diedMark = (s: Session) => String(s.lastActivity ?? s.updated);

/** The board's rows for the chats themselves: waiting on you, stopped mid-turn, working, or starting on an issue. */
export function useChatRows() {

    const visible = computed(() => oldState.value.sessions.filter(inView));
    const byId = computed(() => new Map(visible.value.map(s => [s.id, s])));

    const asking = computed(() => visible.value.filter(s => waitsOnYou(s) && !(s.needsId && !s.asking && handled.has(s.needsId))));
    const died = computed(() => visible.value.filter(s => !!s.died && isMaster(s) && s.status !== 'working' && !waitsOnYou(s) && store.get(`died-seen:${s.id}`) !== diedMark(s)));
    // "#N · starting…": the main chat took the issue on, but no subagent or MR shows it yet
    const starting = computed(() => visible.value.filter(isMaster).flatMap(s => {
        const items = visible.value.filter(o => o.project === s.project).flatMap(o => o.items || []);

        return startingIssues(s, items).map(n => ({ key: `starting:${s.id}:${n}`, sid: s.id, n }));
    }));
    // one row per session: a "starting #N" placeholder already stands for a working chat
    const working = computed(() => visible.value.filter(s => isMaster(s) && s.status === 'working' && !waitsOnYou(s) && !starting.value.some(p => p.sid === s.id)));

    /** A reply that wrongly needs you can be marked as handled; a question or permission prompt is answered in the chat (null). */
    const replyOf = (s: Session) => (s.asking ? null : s.needsId ?? null);
    const markDone = (s: Session) => {
        const reply = replyOf(s);
        if (reply) {
            markHandled(s.id, reply).then(() => handled.add(reply), () => {}); // the next poll has the server's word either way
        }
    };
    const openDied = (s: Session) => {
        store.set(`died-seen:${s.id}`, diedMark(s));
        focusChat(s.id);
    };

    const title = (s: Session) => s.title || sessionTopic(s);
    // "now" or "3m ago": how long the chat has been quiet
    const quietFor = (s: Session) => ago(s.lastActivity ?? s.updated);

    return {
        byId, asking, died, starting, working, replyOf, markDone, openDied, title, quietFor, workingTitle, workingLine,
        focus: (id: string) => focusChat(id), bind: (id: string) => bindChat(id)
    };
}
