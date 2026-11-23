import { computed } from 'vue';
import { hooks } from 'old/core.js';
import { oldState } from '@/old';

/**
 * The header note when Homebase changed on disk (app.js refreshVersion): server code ("Reload server": the server
 * replaces itself, and the page reloads once the new one answers) or only browser files ("Refresh").
 */
export function useUpdate() {

    const update = computed(() => oldState.value.update ?? null);
    const reloading = computed(() => Boolean(update.value?.reloading));
    const text = computed(() => (reloading.value ? 'Reloading the server…' : update.value?.server ? 'Homebase was updated —' : 'Page updated —'));
    const action = computed(() => (update.value?.server ? 'Reload server' : 'Refresh'));

    function apply() {

        if (update.value?.server) {
            hooks.reloadServer?.();
        } else {
            location.reload();
        }
    }

    return { shown: computed(() => update.value != null), reloading, text, action, apply };
}
