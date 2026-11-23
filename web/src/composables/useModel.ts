import { shallowRef, toRef, watch } from 'vue';
import { api, state } from 'old/core.js';
import { modelName } from '@/lib/chat';
import { useChat } from './useChat';
import { useNotice } from './useNotice';

const MODEL_PENDING_MS = 60_000;
/** The aliases Claude Code's /model takes, as the menu lists them. */
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'default'] as const;

const { session, turn, dialogOn } = useChat();
/** A /model sent, until the chat's replies show that model. */
const picked = shallowRef<{ sid: string; name: string; at: number } | null>(null);
// over once the transcript shows the model, the pane is another chat's, or it took too long
watch([session, turn], () => {
    const p = picked.value, s = session.value;
    if (p && (p.sid !== s?.id || modelName(s.model) === p.name || Date.now() - p.at > MODEL_PENDING_MS)) {
        picked.value = null;
    }
});

/** The chat's model chip: the model of its latest reply, and picking another one. */
export function useModel() {

    const { showError } = useNotice();
    const name = toRef(() => picked.value?.name ?? modelName(session.value?.model));

    // Claude Code takes /model <alias> as a normal message and switches at once (it also saves it as the default for new chats)
    async function pick(alias: string) {

        const s = session.value;
        if (!s || state.asking) {
            return;
        }

        picked.value = { sid: s.id, name: alias === 'default' ? 'Default' : modelName(alias) ?? alias, at: Date.now() };
        dialogOn.value = s.id; // Claude may ask "Switch model?" before it switches
        try {
            const r = await api(`/api/send?id=${encodeURIComponent(s.id)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `/model ${alias}` });
            if (!r.ok) {
                throw new Error(await r.text());
            }
        } catch (e) {
            picked.value = null;
            showError((e as Error).message);
        }
    }

    return {
        picked, pick,
        /** no chip for no chat, a chat still starting, or a model not known yet */
        shown: toRef(() => !!session.value && !session.value.id.startsWith('cc-new-') && !!name.value),
        label: toRef(() => (picked.value ? `${picked.value.name}…` : `${name.value ?? ''} ▾`)),
        isCurrent: (alias: string) => modelName(alias) === name.value,
        // /model goes through send, whose Esc would decline an open question
        locked: toRef(() => !!turn.value?.asking)
    };
}
