import { ref } from 'vue';
import { friendly } from '@/lib/text';

const error = ref('');
const info = ref('');
/** Raw server and tmux errors become plain sentences. */
const showError = (msg: string) => { error.value = friendly(msg); };

/** The red error line above the message box and the muted info line above it ("Restarting Claude…"). */
export function useNotice() {
    return { error, info, showError };
}
