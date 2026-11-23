import { toRef } from 'vue';
import { push } from 'old/core.js';
import { oldState } from '@/old';

/** This device's push notifications as the + menu words them; app.js owns the state and handles the menu item. */
export function usePush() {
    return { label: toRef(() => (oldState.value, push.label)), state: toRef(() => (oldState.value, push.state)) };
}
