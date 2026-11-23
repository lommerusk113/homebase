import { nextTick, shallowRef } from 'vue';
import { api, composer, state } from 'old/core.js';
import { postAnswer, type Card } from './useAsk';

const card = shallowRef<Card | null>(null);

// A blocking Claude Code startup dialog (workspace trust, first run) read off the tmux pane of a chat still starting.
// Picking an option has the server move the ❯ selection there and confirm; while it is up (state.boot), sends are blocked.
async function check(tmux: string | null | undefined) {

    let dialog: NonNullable<typeof state.boot> | null = null;
    try {
        const r = tmux && await api(`/api/startup?tmux=${encodeURIComponent(tmux)}`);
        dialog = r && r.ok ? (await r.json()).dialog : null;
    } catch {}
    if (state.boot !== undefined && JSON.stringify(dialog) === JSON.stringify(state.boot)) { // undefined: draw again
        return;
    }

    state.boot = dialog;
    const url = `/api/startup?tmux=${encodeURIComponent(tmux ?? '')}`, options = dialog?.options ?? [];
    card.value = dialog && tmux ? {
        tmux,
        question: dialog.question,
        options: options.map(label => ({ label })),
        async answer(n) {
            try {
                await postAnswer(`${url}&option=${n}&label=${encodeURIComponent(options[n])}`);
            } finally {
                state.boot = undefined;
                check(tmux);
            }
        }
    } : null;
}

composer.boot = async tmux => {
    await check(tmux);
    await nextTick();
};

/** The "Claude is waiting on a startup question" card of a chat that is still starting. */
export function useBoot() {
    return { card };
}
