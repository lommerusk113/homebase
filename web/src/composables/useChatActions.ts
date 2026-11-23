import { computed, ref, shallowRef, toRef, watch } from 'vue';
import { api, store, canCompact, autoCompactDue, compactNudgeDue } from 'old/core.js';
import { setNeedsOnly } from 'old/chat.js';
import { useChat } from './useChat';
import { useNotice } from './useNotice';

/** The actions that ask first. */
export type Confirm = 'clear' | 'restart' | 'compact';

const { session, turn, refresh } = useChat();
const { error, info, showError } = useNotice();
const needsOnly = ref(store.get('needs-only') === '1');
const autoCompact = ref(store.get('auto-compact') !== '0'); // explicit off is kept; unset means on
/** A request to confirm an action: a new object each time, so asking twice opens the dialog twice. */
const confirming = shallowRef<{ what: Confirm } | null>(null);

async function post(path: string, sid: string) {
    const r = await api(`/api/${path}?id=${encodeURIComponent(sid)}`, { method: 'POST' });
    if (!r.ok) {
        throw new Error(await r.text());
    }
}

/** POSTs an action on the open chat, with the error line cleared first and saying why when it fails. */
async function act(path: string, then: (s: Session) => void) {

    const s = session.value;
    error.value = '';
    if (!s) {
        return;
    }

    try {
        await post(path, s.id);
        then(s);
    } catch (e) {
        showError((e as Error).message);
    }
}

// /compact only runs on an idle Claude (the server refuses otherwise)
const canCompactNow = computed(() => {
    const s = session.value, t = turn.value;
    return !!s && !!t && !t.error && canCompact(s) && !t.working && !t.asking;
});
// the auto mode piggybacks on the chat's poll
watch(turn, () => {
    const s = session.value, key = `auto-compacted:${s?.id}`, now = Date.now();
    if (s && canCompactNow.value && store.get('auto-compact') !== '0' && autoCompactDue(s, now, Number(store.get(key)) || 0)) {
        store.set(key, String(now)); // before the POST, so a slow or failed one is not retried within the hour
        act('compact', () => setTimeout(refresh, 1000));
    }
});

/** What the chat's + menu, its dialogs and the status line's buttons do to the open chat. */
export function useChatActions() {
    return {
        needsOnly, autoCompact, confirming, canCompact: canCompactNow,
        hasChat: toRef(() => !!session.value),
        compactDue: computed(() => canCompactNow.value && compactNudgeDue(session.value as Session)),
        confirm: (what: Confirm) => { confirming.value = { what }; },
        compact: () => act('compact', () => setTimeout(refresh, 1000)),
        async restart() {
            info.value = 'Restarting Claude…';
            await act('restart', () => {});
            info.value = '';
            refresh();
        },
        /** New conversation: Claude forgets the context, and the feed starts empty. */
        clear: () => act('clear', s => {
            store.set(`cleared:${s.id}`, JSON.stringify({ at: Date.now(), mode: 'new' }));
            refresh();
        }),
        /** Clear view: earlier messages stay hidden in Homebase only. */
        hideEarlier() {
            if (session.value) {
                store.set(`cleared:${session.value.id}`, String(Date.now()));
                refresh();
            }
        },
        /** Hides FYI bubbles (and tool lines), keeping needs-you, the user's own and the newest Claude bubble. */
        toggleNeedsOnly() {
            needsOnly.value = !needsOnly.value;
            setNeedsOnly(needsOnly.value);
        },
        toggleAutoCompact() {
            autoCompact.value = !autoCompact.value;
            store.set('auto-compact', autoCompact.value ? '1' : '0');
        }
    };
}
