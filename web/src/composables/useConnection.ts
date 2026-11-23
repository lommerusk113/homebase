import { computed } from 'vue';
import { oldState } from '@/old';

/** Whether the last poll failed, and the header's word for it: a 500 is Homebase itself failing, not the connection. */
export function useConnection() {

    const offline = computed(() => Boolean(oldState.value.offline));
    const label = computed(() => (oldState.value.serverError ? 'Server error' : 'Offline'));

    return { offline, label };
}
