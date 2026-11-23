import { toRef, watch } from 'vue';
import { state, touch } from 'old/core.js';
import { oldState } from '@/old';
import { sessionTopic } from '@/lib/board';
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

    const { session, target, helper } = useChat();
    const draft = useDraft();
    const { attached, remove, upload } = useAttachments();
    const { error, showError } = useNotice();
    const { send } = useSend();
    const discuss = useDiscuss();

    // a helper's box has a draft of its own, apart from the chat that started it
    const key = () => (session.value && helper.value ? `${session.value.id}:${helper.value.id}` : session.value?.id ?? null);
    watch(key, draft.follow, { immediate: true });

    async function submit() {

        const files = attached.value, to = target.value, id = key();
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
        draft.put(id!, '');
        text = discuss.take(text); // a failed send gives the wrapped text back, which is not wrapped twice
        // a helper can't be typed into: its chat is asked to pass the text on
        const ok = await send(to, helper.value ? `Send this to helper '${helper.value.description}' (SendMessage to ${helper.value.id}), verbatim: ${text}` : text);
        if (draft.chat() !== id) {
            // switched chats meanwhile: the box is the other chat's now, so a failed text goes back into its own chat's draft
            if (!ok && id && !draft.saved(id)) {
                draft.keep(id, text);
            }
        } else if (!ok && !draft.text.value) {
            draft.put(id!, text); // give the text back so it isn't lost
        } else {
            draft.keep(id); // keeps whatever was typed meanwhile
        }
    }

    return {
        ...draft, submit,
        focusAsked: useComposerFocus().focusAsked,
        /** a touch screen: no hover, and a keyboard whose Enter can only add a line */
        entersLine: touch,
        label: toRef(() => (session.value ? `Message Claude in ${session.value.project}` : 'Message Claude')),
        /** the box's placeholder */
        hint: toRef(() => (helper.value ? 'Message goes to this helper via its main chat' : discuss.discussing.value ? 'Discuss this question…' : `Message ${session.value && (oldState.value, state.focus === session.value.id) ? session.value.title || sessionTopic(session.value) : 'main chat'}…`))
    };
}
