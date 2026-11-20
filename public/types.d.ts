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
    /** a question (AskUserQuestion) or a permission prompt waits on the user */
    asking: boolean;
    /** the text of that question or prompt; null when not asking */
    question: string | null;
    /** idle, and Claude's newest reply asks for the user's decision, answer or action (as the chat's needs-you bubble) */
    needsYou: boolean;
    /** start of the running turn; null when idle or unknown */
    since: number | null;
    /** the human prompt the running turn works on; null when idle */
    now: string | null;
    /** the running turn's newest tool call in words ("running npm test"); null when idle */
    step?: string | null;
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
    /** origin is the personal (hobby) GitHub account */
    hobby?: boolean;
    /** commits ahead of the upstream; null when there is no upstream */
    unpushed?: number | null;
    /** context window used, % (from the status-line dump); null when there is none */
    context: number | null;
    /** when that dump was written, ms */
    contextAt: number | null;
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
    blocked?: 'conflict' | 'rebase' | 'blocked' | 'checks' | null;
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
    firstTitle?: string | null; // the agent's spawn description, when a later SendMessage renamed the row
    pr: string | null;
    forgeError?: string | null; // why the last MR/PR lookup (or its comments, "comments: …") failed; the last good data is kept
    prState: PrState | null;
    column: Column;
    /** index into LIFECYCLE */
    stage: number;
    stageLabel: string;
    agentStatus: string | null;
    /** when a running agent started its current step (`next` names it); null otherwise */
    stepAt: number | null;
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

interface Answer { text: string; at?: string; queued?: boolean; sending?: boolean; error?: string; unconfirmed?: boolean }

interface ChatItem {
    role: 'user' | 'assistant' | 'tools' | 'error' | 'compact';
    text: string;
    at?: string;
    topic?: string | null;
    needsYou?: boolean;
    tldr?: string | null;
    interrupted?: boolean;
    /** a tools line with no edits or agents, hidden as noise */
    quiet?: boolean;
    /** queued in the server's send queue */
    pending?: boolean;
    replies?: string[];
    /** the choices in a message that asks something (an exact substring of text), shown outside the fold */
    options?: string;
    /** what the reply says still waits on the user (its "Waiting on you: …"), kept after the user says something else */
    waiting?: string;
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
    /** sent after the text but not shown, kept for Retry */
    note?: string;
    okAt?: number;
    /** sent, but the transcript still doesn't show it OUTBOX_TTL_MS later */
    unconfirmed?: boolean;
}

interface Transcript {
    items: ChatItem[];
    earlier?: number; // older items the `max` cut left out
    asking: string | null;
    questions: { question: string; options: string[]; descriptions?: string[] }[] | null;
    working: boolean;
    /** an open turn with no write for 30 min */
    stuck?: boolean;
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
    milestoneTitle?: string;
    desc: string;
    updated: string;
    mrs: IssueMr[];
}

interface IssueGroups { closable: Issue[]; doing: Issue[]; assigned: Issue[]; unassigned: Issue[]; done: Issue[] }

interface MilestoneSummary { id: number; title: string; due: string | null; url: string; group: boolean; closed: number; total: number }

interface SelectedMilestone extends Omit<MilestoneSummary, 'id' | 'total'> {
    id: number | 'mine';
    total: number | null;
    mine?: boolean; // the "Assigned to me" view
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
interface WaInput extends HTMLElement { value: string; hint: string; disabled: boolean }
interface WaSwitch extends HTMLElement { checked: boolean; disabled: boolean }
interface WaDetails extends HTMLElement { open: boolean }
interface WaSelect extends HTMLElement { open: boolean; value: string }
interface WaOption extends HTMLElement { value: string }
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

// ---- /api/log?project=: LogResponse ----

interface LogCommit {
    hash: string;
    short: string;
    at: number;
    subject: string;
    /** the ref git log --source reached it by, shortened; the default branch for its unpushed commits */
    branch: string;
    /** null when the repo has no remote refs */
    pushed: boolean | null;
    /** on the default branch and on no remote */
    unpushed: boolean;
}
interface LogAgent { kind: 'agent'; id: string; at: number; started: number | null; description: string; tldr: string | null; body: string; pr: string | null; prState: PrState | null; branches: string[]; time: string | null; tokens: string | null; commits: LogCommit[] }
type LogEntry = LogAgent
    | (LogCommit & { kind: 'commit' })
    | { kind: 'topic'; at: number; topic: string; tldr: string | null }
    | { kind: 'mr'; at: number; url: string; state: string; title: string | null };
interface LogResponse { project: string; repo: string | null; defaultBranch: string | null; error: string | null; days: { label: string; entries: LogEntry[] }[] }

/** Elements in index.html that $() callers use beyond HTMLElement. */
interface PageIds {
    project: WaSelect;
    dlg: WaDialog;
    'clear-dlg': WaDialog;
    'new-dlg': WaDialog;
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
    'c-menu': WaDropdown;
    send: HTMLFormElement;
    'send-btn': HTMLButtonElement;
    attached: HTMLDivElement;
    'attach-btn': HTMLButtonElement;
    'attach-input': HTMLInputElement;
}

// The DOM stringifies these (aria-pressed, aria-selected, aria-expanded take true/false).
interface Element { setAttribute(qualifiedName: string, value: string | boolean | number): void }
