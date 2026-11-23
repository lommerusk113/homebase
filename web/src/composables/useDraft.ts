import { ref, shallowRef } from 'vue';
import { saveDraft, loadDraft, stashPaste, loadPastes, expandPastes, isLongPaste } from '@/lib/draft';
import { useNotice } from './useNotice';

const storage = () => {
    try {
        return sessionStorage;
    } catch {
        return null;
    }
};

const text = ref('');
/** A selection for the box to take: a restored draft's, or the end of a paste label. */
const caret = shallowRef<{ start: number; end: number } | null>(null);
// ponytail: the selection as of the last input, not of a caret moved since; track selectionchange if that matters
let selection: { start?: number | null; end?: number | null } = {};
let chat: string | null | undefined; // the chat the text and the error line belong to; null: a project still starting

/** The message box's text: kept per chat in sessionStorage across reloads, long pastes as labels until sent. */
export function useDraft() {

    const { error } = useNotice();
    const keep = (sid: string | null | undefined, value = text.value) => saveDraft(storage(), sid, { text: value, ...selection });

    // The box follows the chat: switching saves the old chat's draft, clears the box and the error line, and restores
    // the new chat's draft. A starting project's text stays for the session it becomes.
    function follow(sid: string | null) {

        if (sid === chat) {
            return;
        }

        const old = chat;
        chat = sid;
        if (old) {
            keep(old);
            text.value = '';
            error.value = '';
        }

        const draft = sid && loadDraft(storage(), sid, text.value);
        if (draft) {
            text.value = draft.text;
            caret.value = draft.start != null ? { start: draft.start, end: draft.end ?? draft.start } : null;
        }
    }

    function typed(value: string, start?: number | null, end?: number | null) {
        text.value = value;
        selection = { start, end };
        keep(chat);
    }

    /** A long paste over the selection becomes its label, with the caret after it; false for a short one, which the box takes as typed. */
    function paste(raw: string, start: number, end: number): boolean {

        if (!isLongPaste(raw)) {
            return false;
        }

        const label = stashPaste(storage(), raw.replace(/\r\n?/g, '\n'));
        const at = start + label.length;
        caret.value = { start: at, end: at };
        typed(text.value.slice(0, start) + label + text.value.slice(end), at, at);

        return true;
    }

    /** Sets the box (emptied when a send starts, filled when a failed one gives its text back) and sid's draft with it. */
    function put(sid: string, value: string) {
        text.value = value;
        keep(sid);
    }

    return {
        text, caret, follow, typed, paste, put, keep,
        /** the chat the box belongs to now */
        chat: () => chat,
        /** what would be sent: trimmed, paste labels expanded */
        expanded: () => expandPastes(text.value.trim(), loadPastes(storage())),
        saved: (sid: string) => !!loadDraft(storage(), sid)
    };
}
