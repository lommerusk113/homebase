// The message box's draft and long pastes in sessionStorage. No Vue and no page imports: tests/unit loads this file as is.

/** The typed text and its selection. */
export interface Draft { text: string; start?: number | null; end?: number | null }
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** Keeps a chat's draft, so a reload doesn't lose typed text. Empty text removes it. */
export function saveDraft(storage: Store, sid: string | null | undefined, draft: Draft): void {
    try {
        if (!sid || !storage) {
            return;
        }
        if (draft.text) {
            storage.setItem(`draft:${sid}`, JSON.stringify({ text: draft.text, start: draft.start, end: draft.end }));
        } else {
            storage.removeItem(`draft:${sid}`);
        }
    } catch {}
}

/** The saved draft for a box holding `typed`: null when there is none, or when something is typed already. */
export function loadDraft(storage: Store, sid: string, typed = ''): Draft | null {
    try {
        const d = JSON.parse(storage?.getItem(`draft:${sid}`) ?? 'null');

        return d?.text && !typed ? d : null;
    } catch {
        return null;
    }
}

// Long pastes sit in the box as "[Pasted text #n +L lines]", like Claude Code, and expand on send. Kept in sessionStorage
// so a restored draft still expands after a reload.
const PASTE_LINES = 5, PASTE_CHARS = 800;
export const pasteLabel = (n: number, text: string) => `[Pasted text #${n} +${text.split('\n').length} lines]`;
export const isLongPaste = (text: string) => text.split('\n').length >= PASTE_LINES || text.length > PASTE_CHARS;
export const expandPastes = (text: string, pastes: Record<string, string>) => text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, n) => pastes[n] ?? m);

export function loadPastes(storage: Store): Record<string, string> {
    try {
        return JSON.parse(storage?.getItem('pastes') ?? '{}') ?? {};
    } catch {
        return {};
    }
}

/** Stores a long paste; returns the label to put in the box. */
export function stashPaste(storage: Store, text: string): string {

    const pastes = loadPastes(storage);
    const n = Math.max(0, ...Object.keys(pastes).map(Number)) + 1;
    pastes[n] = text;
    try {
        storage?.setItem('pastes', JSON.stringify(pastes));
    } catch {}

    return pasteLabel(n, text);
}
