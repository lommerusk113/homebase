import { toRef } from 'vue';
import { api, vue } from 'old/core.js';
import { useChat } from './useChat';
import { useChatActions } from './useChatActions';
import { useSend } from './useSend';

/** "Rules changed since this chat started": the files that changed, and the strip's three actions. */
export function useRules() {

    const { session } = useChat();
    const { send } = useSend();
    const { confirm } = useChatActions();
    const stale = toRef(() => session.value?.rulesStale);

    // on the server, so every device agrees; hidden here at once, the next poll drops it everywhere
    function dismiss() {

        const s = session.value;
        if (!s) {
            return;
        }
        api('/api/rules/seen', { method: 'POST', body: JSON.stringify({ id: s.id, at: s.rulesAt ?? 0 }) }).catch(() => {});
        s.rulesStale = undefined;
        vue.bump();
    }

    return {
        stale,
        title: toRef(() => (stale.value ? `Changed: ${stale.value.join(', ')}` : undefined)),
        dismiss,
        /** Claude re-reads the files itself: no restart, so running agents keep going. */
        async load() {

            const s = session.value;
            if (s && await send(s.id, s.rulesReload!, undefined, undefined, true, undefined, true)) { // housekeeping: no answer to anything
                dismiss();
            }
        },
        restart: () => confirm('restart')
    };
}
