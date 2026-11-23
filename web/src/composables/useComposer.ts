import { toRef, watch } from 'vue';
import { state, touch } from 'old/core.js';
import { useChat } from './useChat';
import { useComposerFocus } from './useComposerFocus';
import { useDiscuss } from './useDiscuss';
import { useDraft } from './useDraft';
import { useAttachments } from './useAttachments';
import { useNotice } from './useNotice';
import { useSend } from './useSend';

let uploading = false;

/** The message box of the open chat: its draft follows the chat, and submit sends the text with the attached images. */
export function useComposer() {

    const { session, target } = useChat();
    const draft = useDraft();
    const { attached, remove, upload } = useAttachments();
    const { error, showError } = useNotice();
    const { send } = useSend();
    const discuss = useDiscuss();

    watch(() => session.value?.id ?? null, draft.follow, { immediate: true });

    async function submit() {

        const s = session.value, files = attached.value, to = target.value;
        let text = draft.expanded();
        if (!text && !files.length) {
            return;
        }
        if (state.boot) {
            error.value = 'Claude is waiting on a startup question above';
            return;
        }
        if (!to) {
            return;
        }

        if (files.length) {
            if (uploading) {
                return; // a second Enter while the first upload runs
            }
            error.value = '';
            uploading = true;
            try {
                text = [text, ...await upload(files)].filter(Boolean).join('\n');
            } catch (e) {
                showError((e as Error).message); // text and images stay for another try
                return;
            } finally {
                uploading = false;
            }
            remove(files); // keeps any attached while uploading
        }

        // cleared at once (the "sending…" bubble shows progress), and the draft with it: a reload during a slow send
        // must not bring the sent text back
        draft.put(to, '');
        text = discuss.take(text); // a failed send gives the wrapped text back, which is not wrapped twice
        const ok = await send(to, text);
        if (draft.chat() !== (s?.id ?? null)) {
            // switched chats meanwhile: the box is the other chat's now, so a failed text goes back into its own chat's draft
            if (!ok && s && !draft.saved(s.id)) {
                draft.keep(s.id, text);
            }
        } else if (!ok && !draft.text.value) {
            draft.put(to, text); // give the text back so it isn't lost
        } else {
            draft.keep(to); // keeps whatever was typed meanwhile
        }
    }

    return {
        ...draft, submit,
        focusAsked: useComposerFocus().focusAsked,
        /** a touch screen: no hover, and a keyboard whose Enter can only add a line */
        entersLine: touch,
        label: toRef(() => (session.value ? `Message Claude in ${session.value.project}` : 'Message Claude')),
        /** the box's placeholder */
        hint: toRef(() => (discuss.discussing.value ? 'Discuss this question…' : `${session.value ? `Message Claude in ${session.value.project}` : 'Message Claude'}…`))
    };
}
