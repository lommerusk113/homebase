import { ref } from 'vue';
import { composer } from 'old/core.js';
import { discussText } from '@/lib/discuss';

const discussing = ref(false); // the user chose Discuss on the question card: their next message is about it
composer.endDiscuss = () => { discussing.value = false }; // old chat.js: focusing or leaving a chat ends it

/**
 * Discuss on a question card: the composer takes the focus with a hint, and the next send is typed as a discussion
 * (the server's typed send answers the picker's text box, else declines it with Esc and types the message).
 */
export function useDiscuss() {
    return {
        discussing,
        start: () => { discussing.value = true; },
        end: () => { discussing.value = false; },
        /** the text to send: wrapped while discussing (which ends it), else as it is */
        take(text: string) {
            if (!discussing.value) {
                return text;
            }
            discussing.value = false;

            return discussText(text);
        }
    };
}
