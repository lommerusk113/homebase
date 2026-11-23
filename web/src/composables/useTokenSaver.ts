import { shallowRef } from 'vue';
import { api } from 'old/core.js';

/** Token saver (server/saver.mjs): chats started or reloaded from now on run their helpers on Sonnet. Kept on the server, so it survives a reload and shows on a paired phone. */
const on = shallowRef(false);
const note = shallowRef('');
const show = (j: { on?: boolean; auto?: boolean; used?: number }) => {
    on.value = Boolean(j.on);
    note.value = j.auto && !j.on ? `on: ${j.used}% used` : '';
};
let asked = false;

export function useTokenSaver() {

    if (!asked) {
        asked = true;
        api('/api/saver').then(r => r.json()).then(show, () => { asked = false; });
    }

    async function set(value: boolean) {

        const before = on.value;
        on.value = value;
        try {
            const r = await api('/api/saver', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: value }) });
            if (!r.ok) {
                throw new Error(String(r.status));
            }
            show(await r.json());
        } catch {
            on.value = before;
        }
    }

    return { on, note, set };
}
