// Types for the page's JSDoc, checked by ./check-types.sh (tsc --noEmit). Never loaded by the browser.
// API shapes are taken from real /api/sessions, /api/transcript, /api/milestones and /api/limits answers.
// Global on purpose (no import/export), so the .js files use them in JSDoc without importing.

// ---- /api/sessions: Session[] ----

interface Session {
    id: string;
    cwd: string;
    dir: string;
    project: string;
    branch: string;
    title: string;
    pr: string | null;
    prs: { url: string; at: number }[];
    model: string;
    status: string;
    lastPrompt: string;
    lastReply: string;
    /** topic of Claude's newest reply that has one (▸ header) */
    topic: string | null;
    /** a question (AskUserQuestion) waits on the user */
    asking: boolean;
    /** start of the running turn; null when idle or unknown */
    since: number | null;
    /** the human prompt the running turn works on; null when idle */
    now: string | null;
    /** human prompts waiting in Claude Code's queue */
    queued: string[];
    /** running subagents, and those finished in the last 2h */
    subagents: { running: number; finished: number };
    files: string[];
    updated: number;
    created: number;
    /** last human prompt or Claude text/tool call, not file mtime; null when the transcript has none */
    lastActivity: number | null;
    /** the transcript was written by a subagent */
    sidechain: boolean;
    items: WorkItem[];
    tmux?: string;
    /** set on the session a /clear started: the id of the one it replaced */
    clearedFrom?: string;
}

type Column = 'needs-you' | 'doing' | 'review' | 'ready' | 'finished' | 'done' | 'idle';

interface Pipeline { status: string; url?: string; at?: string }

interface PrState {
    state: string;
    title: string;
    branch: string;
    reviewers: string[];
    ready: boolean;
    changes: boolean;
    changesBy: string[];
    draft: boolean;
    ci: 'failing' | 'running' | 'passing' | string | null;
    pipeline: Pipeline | null;
    milestone: Milestone | null;
    target: string;
    issue: string;
    sha: string;
    replied: number;
    repliedTo: string[];
}

interface Milestone { id: number; title: string; due_date?: string | null }

interface ReviewComment { id: number; author: string; at: string; excerpt: string; url: string; resolved: boolean }

interface Comments {
    latestAt: string | null;
    count: number;
    items: ReviewComment[];
    unresolved: number;
    unresolvedBy: string[];
    replied: number;
    repliedTo: string[];
}

interface Gate { verdict: 'ready' | 'fix first' | string; at: number; tldr: string | null; commit: string | null; stale: boolean }

interface RowAction { label: string; message: string }

interface Activity { id: string; description: string; status: string; tldr: string | null }

interface WorkItem {
    key: string;
    project: string;
    sessionId: string;
    title: string;
    pr: string | null;
    prState: PrState | null;
    column: Column;
    /** index into LIFECYCLE */
    stage: number;
    stageLabel: string;
    agentStatus: string | null;
    updated: number;
    branch: string;
    worktreePath: string | null;
    folder: string;
    tldr: string | null;
    body: string;
    files: string[];
    activity: Activity[];
    requested: { at: number; text: string } | null;
    next: string;
    action: RowAction | null;
    gate: Gate | null;
    tokens: string | null;
    tokensTitle: string | null;
    time: string | null;
    milestone: Milestone | null;
    comments: Comments | null;
    /** client-only: optimistic "sent" mark (list.js) */
    sent?: number;
}

/** A list.js attentionEvents() transition, turned into a desktop notification by app.js. */
interface AttentionEvent { kind: 'needs-you' | 'ready' | 'finished' | 'failing' | 'comment'; item: WorkItem; comments?: ReviewComment[] }

// ---- /api/transcript ----

interface Answer { text: string; at?: string; queued?: boolean; sending?: boolean; error?: string }

interface ChatItem {
    role: 'user' | 'assistant' | 'tools' | 'error';
    text: string;
    at?: string;
    topic?: string | null;
    needsYou?: boolean;
    tldr?: string | null;
    interrupted?: boolean;
    /** queued in the server's send queue */
    pending?: boolean;
    replies?: string[];
    answer?: Answer;
    // client-only (chat.js outbox and decorations)
    sending?: boolean;
    error?: string;
}

/** A message typed in Homebase that the transcript doesn't show yet. */
interface OutboxItem extends ChatItem {
    role: 'user';
    sid: string;
    at: string;
    answerTo?: string;
    okAt?: number;
}

interface Transcript {
    items: ChatItem[];
    asking: string | null;
    questions: { question: string; options: string[] }[] | null;
    working: boolean;
    since?: number;
}

// ---- /api/milestones ----

interface Person { name: string; username: string }

interface IssueMr { iid: number; url: string; state: string; author?: Person; pipeline?: Pipeline }

interface Issue {
    iid: number;
    title: string;
    state: string;
    assignees: Person[];
    url: string;
    milestone?: number;
    desc: string;
    updated: string;
    mrs: IssueMr[];
}

interface IssueGroups { closable: Issue[]; doing: Issue[]; assigned: Issue[]; unassigned: Issue[]; done: Issue[] }

interface MilestoneSummary { id: number; title: string; due: string | null; url: string; group: boolean; closed: number; total: number }

interface SelectedMilestone extends MilestoneSummary {
    groups?: IssueGroups;
    loading?: boolean;
    error?: string | null;
}

interface Milestones {
    project: string;
    milestones: MilestoneSummary[];
    detected: number[];
    me: Person | null;
    selected: SelectedMilestone | null;
    updating: boolean;
    loading: boolean;
    reason: 'none' | 'error' | 'unsupported' | null;
    error?: string;
    url: string | null;
}

// ---- /api/limits, /api/refresh, /api/editors ----

interface LimitWindow { used: number; resetsAt: number }
interface Limits { fiveHour?: LimitWindow; sevenDay?: LimitWindow; updated?: number }
interface RefreshState { refreshing: boolean; lastRefreshedAt: number }
interface Editor { id: string; name: string }

// ---- page globals (index.html <script> tags) ----

declare const marked: { parse(md: string): string; parseInline(md: string): string };
declare const DOMPurify: { sanitize(html: string): string };

// ---- Web Awesome: only what the page touches ----

interface WaDialog extends HTMLElement { open: boolean }
interface WaDetails extends HTMLElement { open: boolean }
interface WaSelect extends HTMLElement { open: boolean; value: string }
interface WaOption extends HTMLElement { value: string }
interface WaDropdown extends HTMLElement { open: boolean }
interface WaDropdownItem extends HTMLElement { value: string; checked: boolean }
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
    'wa-select': WaSelect;
    'wa-option': WaOption;
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
    project: WaSelect;
    dlg: WaDialog;
    'clear-dlg': WaDialog;
    msg: WaTextarea;
    'needs-only': WaDropdownItem;
    'c-menu': WaDropdown;
    send: HTMLFormElement;
    'send-btn': HTMLButtonElement;
}

// The DOM stringifies these (aria-pressed, aria-selected, aria-expanded take true/false).
interface Element { setAttribute(qualifiedName: string, value: string | boolean | number): void }
