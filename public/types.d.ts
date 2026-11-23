// Types for the page's JSDoc, checked by ./check-types.sh (tsc --noEmit). Never loaded by the browser.
// The API's response shapes live in api.d.ts; this file has what only this page uses.
// Global on purpose (no import/export), so the .js files use them in JSDoc without importing.

// ---- client-only shapes ----

/** A list.js attentionEvents() transition, turned into a desktop notification by app.js. */
// 'asking' is about a session (asking or needs you) and has no item; the rest are about a work item
interface AttentionEvent { kind: 'needs-you' | 'ready' | 'finished' | 'failing' | 'comment' | 'asking'; item?: WorkItem; session?: Session; comments?: ReviewComment[] }

/** A message typed in Homebase that the transcript doesn't show yet. */
interface OutboxItem extends ChatItem {
    role: 'user';
    sid: string;
    at: string;
    answerTo?: string;
    /** sent after the text but not shown, kept for Retry */
    note?: string;
    /** typed into an open question's text box: the transcript has it as that question's answer, if at all */
    answered?: boolean;
    /** a button's message (row action, Load rules), not typed by the user */
    canned?: boolean;
    okAt?: number;
    /** the server refused it (409): its error says why, and there is no Retry */
    refused?: boolean;
    /** sent, but the transcript still doesn't show it OUTBOX_TTL_MS later */
    unconfirmed?: boolean;
    /** a slash command's panel or output (control.mjs settleCommand); pick: a picker closed unanswered; stuck: Esc didn't close it */
    result?: { text: string; pick?: boolean; stuck?: string; warning?: string | null };
}

/** a drawn diff line: hunk header, added, removed, context or a note; o/n are the old and new line numbers */
interface DiffRow { t: 'h' | '+' | '-' | ' ' | 'm'; o?: number; n?: number; text: string }


// ---- page globals (index.html <script> tags) ----

declare const marked: { parse(md: string): string; parseInline(md: string): string };
declare const DOMPurify: { sanitize(html: string, config?: object): string; addHook(name: string, hook: (node: Element) => void): void };

// ---- Web Awesome: only what the page touches ----

interface WaDialog extends HTMLElement { open: boolean }
interface WaInput extends HTMLElement { value: string; hint: string; disabled: boolean }
interface WaSwitch extends HTMLElement { checked: boolean; disabled: boolean }
interface WaDetails extends HTMLElement { open: boolean }
interface WaDropdown extends HTMLElement { open: boolean }
interface WaDropdownItem extends HTMLElement { value: string; checked: boolean; disabled: boolean }
interface WaButton extends HTMLElement { disabled: boolean }
interface WaTextarea extends HTMLElement {
    value: string;
    /** the inner <textarea>, where the selection lives */
    input?: HTMLTextAreaElement;
    updateComplete: Promise<boolean>;
    setSelectionRange(start: number, end: number): void;
}

interface HTMLElementTagNameMap {
    'wa-dialog': WaDialog;
    'wa-details': WaDetails;
    'wa-dropdown': WaDropdown;
    'wa-dropdown-item': WaDropdownItem;
    'wa-button': WaButton;
    'wa-textarea': WaTextarea;
    'wa-tooltip': HTMLElement;
    'wa-badge': HTMLElement;
    'wa-spinner': HTMLElement;
}

interface HTMLElementEventMap {
    'wa-select': CustomEvent<{ item: WaDropdownItem }>;
    'wa-show': Event;
    'wa-hide': Event;
    'wa-after-hide': Event;
}

/** Elements in index.html that $() callers use beyond HTMLElement. */
interface PageIds {
    project: HTMLButtonElement;
    dlg: WaDialog;
    'clear-dlg': WaDialog;
    'new-dlg': WaDialog;
    'pair-dlg': WaDialog;
    'np-name': WaInput;
    'np-desc': WaTextarea;
    'np-private': WaSwitch;
    'np-form': HTMLFormElement;
    'np-go': WaButton;
    'compact-dlg': WaDialog;
    'restart-dlg': WaDialog;
    msg: WaTextarea;
    'needs-only': WaDropdownItem;
    'auto-compact': WaDropdownItem;
    'compact-item': WaDropdownItem;
    'compact-nudge': HTMLButtonElement;
    send: HTMLFormElement;
    attached: HTMLDivElement;
    'attach-btn': HTMLButtonElement;
    'plus-menu': WaDropdown;
    'attach-input': HTMLInputElement;
}

// The DOM stringifies these (aria-pressed, aria-selected, aria-expanded take true/false).
interface Element { setAttribute(qualifiedName: string, value: string | boolean | number): void }
