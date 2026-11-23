// How many files a chat or a work row changed: read from GET /api/diff when shown and at most every COUNT_MS after,
// never on the poll itself. Module state, so every island shows the same numbers.
import { reactive, toRef, watchEffect } from 'vue';
import { api } from 'old/core.js';
import { chatHead, openDiff } from 'old/diff.js';
import { oldState } from '@/old';
import { diffTotals } from '@/lib/diff';

const COUNT_MS = 15_000;

/** GET /api/diff: a folder's changed files, or with group and file one file's diff. */
export async function getDiff<T = DiffView>(sid: string, item: string | null, more: Record<string, string> = {}): Promise<T> {

    const r = await api(`/api/diff?${new URLSearchParams({ session: sid, ...(item != null && { item }), ...more })}`);
    if (!r.ok) {
        throw new Error(await r.text());
    }

    return r.json();
}

const filesIn = (v: DiffView | null) => (v?.repo ? diffTotals(v).files : 0);

const rows = reactive(new Map<string, number>()); // item key -> changed files
const rowAt = new Map<string, number>(); // item key -> when it was last read

/**
 * A work row's changed files, only for a row with its own worktree or branch: never the chat's folder, which would
 * show unrelated changes. 0 until read, and for a row without either.
 */
export function useRowDiffCount(item: () => WorkItem) {

    const own = () => Boolean((item().worktreePath || item().branch) && item().sessionId);

    watchEffect(() => {
        void oldState.value; // every board redraw is a chance to read it again
        const x = item();
        if (!own() || document.hidden || Date.now() - (rowAt.get(x.key) ?? 0) < COUNT_MS) {
            return;
        }
        rowAt.set(x.key, Date.now()); // one fetch at a time per row
        getDiff(x.sessionId, x.key).then(v => rows.set(x.key, filesIn(v)), () => {});
    });

    return { n: toRef(() => (own() ? rows.get(item().key) ?? 0 : 0)), open: () => openDiff(item().sessionId, item().key) };
}

const chat = reactive({ sid: null as string | null, n: 0 });
let chatAt = 0, chatUpdated = 0;

/** The panel read this chat's changes itself: the header's count follows. */
export function setChatCount(sid: string, v: DiffView | null) {
    if (sid === chat.sid) {
        chat.n = filesIn(v);
    }
}

// Read when the chat changes and, while its transcript moves, at most every COUNT_MS.
function syncChat(s: Session | null) {

    const sid = s && !s.id.startsWith('cc-new-') ? s.id : null;
    if (sid !== chat.sid) {
        Object.assign(chat, { sid, n: 0 });
        chatAt = chatUpdated = 0;
    }
    if (!s || !sid || document.hidden || Date.now() - chatAt < COUNT_MS || (chatAt && s.updated === chatUpdated)) {
        return;
    }

    chatAt = Date.now();
    chatUpdated = s.updated;
    getDiff(sid, null).then(v => setChatCount(sid, v), () => {});
}

/** The shown chat's changed files (sid null: no chat, or one still starting), and the action that opens its Changes. */
export function useChatDiffCount() {

    watchEffect(() => {
        void oldState.value; // syncDiff (public/diff.js) bumps after setting chatHead.session
        syncChat(chatHead.session);
    });

    return { sid: toRef(chat, 'sid'), n: toRef(chat, 'n'), open: () => chat.sid && openDiff(chat.sid) };
}
