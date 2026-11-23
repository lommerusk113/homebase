import { nextTick, ref } from 'vue';
import { notifyOn, store } from 'old/core.js';

const on = ref(notifyOn());

/** The header bell: desktop notifications on or off for this browser. Permission is only ever requested from its click. */
export function useBell() {

    const supported = Boolean(window.Notification);
    const blocked = ref(false);

    /** @returns whether the browser refused for good: it asks nothing then, so the bell says why nothing happened */
    async function toggle(): Promise<boolean> {

        const granted = !notifyOn() && await Notification.requestPermission() === 'granted';
        const denied = !granted && Notification.permission === 'denied';
        if (denied) {
            blocked.value = true;
            await nextTick();
        }
        store.set('notify', granted ? '1' : '0');
        on.value = notifyOn();

        return denied;
    }

    return { supported, on, blocked, toggle };
}
