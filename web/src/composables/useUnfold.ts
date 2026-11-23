import { ref } from 'vue';
import { state } from 'old/core.js';

// state.unfold is a plain Set the old page's folds share: this counts the changes made here, so a read follows them
const changes = ref(0);

/** Which folds are open (Show more), by key; kept over re-renders. */
export function useUnfold() {

    const isOpen = (key: string) => changes.value >= 0 && state.unfold.has(key);
    /** Opens or closes the fold; true when it is now open. */
    const toggle = (key: string) => {
        const open = !state.unfold.has(key);
        if (open) {
            state.unfold.add(key);
        } else {
            state.unfold.delete(key);
        }
        changes.value++;

        return open;
    };

    return { isOpen, toggle };
}
