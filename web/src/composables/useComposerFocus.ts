import { ref } from 'vue';

const focusAsked = ref(0);

/** Asking the message box to take the focus, from anywhere on the page: it watches focusAsked. */
export function useComposerFocus() {
    return { focusAsked, focus: () => { focusAsked.value++; } };
}
