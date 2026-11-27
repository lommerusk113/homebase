// The API's response shapes, shared by the old page (public/*.js JSDoc, ./check-types.sh) and the new one (web/, vue-tsc).
// Taken from real /api/sessions, /api/transcript, /api/milestones and /api/limits answers. Never loaded by the browser.
// Global on purpose (no import/export), so JSDoc and the Vue app use them without importing.

// ---- /api/sessions: Session[] ----

// A project's forge: its name, why it can't be reached (null when it can) with what to do, and when the oldest open MR state shown was read.
interface ForgeStatus { name: 'GitLab' | 'GitHub'; problem: 'missing' | 'auth' | 'rate' | 'timeout' | 'error' | null; help: string | null; checkedAt: number | null }

interface Session {
    id: string;
    forge?: ForgeStatus | null;
    cwd: string;
    /** the folder its Claude was started in (its tmux start dir), null without a tmux; cwd follows a cd in the chat */
    home?: string | null;
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
    /** when that reply was written, ms; null without one */
    lastReplyAt?: number | null;
    /** topic of Claude's newest reply that has one (▸ header) */
    topic: string | null;
    /** false: a recent transcript has no turn markers, so Claude Code's format probably changed */
    known: boolean;
    /** a question (AskUserQuestion) or a permission prompt waits on the user */
    asking: boolean;
    /** the prompt is a background helper's (shown on this chat's pane) */
    helperAsking?: boolean;
    /** the one running helper that prompt belongs to; null when none or several could be */
    askingAgent?: string | null;
    /** its turn never ended and has been silent for 30 min, since died rows first ran here (never a closed chat) */
    died?: boolean;
    /** the text of that question or prompt; null when not asking */
    question: string | null;
    /** idle, and Claude's newest reply asks for the user's decision, answer or action (as the chat's needs-you bubble) */
    needsYou: boolean;
    /** what that reply asks, one line (its Waiting on you question, else its TLDR); null unless needsYou */
    needsText?: string | null;
    /** what it waits on you about (the question, or the reply's Waiting on you question; never its TLDR); links it to the MR it names */
    asks?: string | null;
    /** that reply's id, to mark it as handled (POST /api/handled); null unless needsYou */
    needsId?: string | null;
    /** start of the running turn; null when idle or unknown */
    since: number | null;
    /** the human prompt the running turn works on; null when idle */
    now: string | null;
    /** the running turn's newest tool call in words ("running npm test"); null when idle */
    step?: string | null;
    /** when that tool call started (ms); null without one */
    stepAt?: number | null;
    /** human prompts waiting in Claude Code's queue */
    queued: string[];
    /** running subagents, and those finished in the last 2h */
    subagents: { running: number; finished: number };
    files: string[];
    updated: number;
    /** the died turn's last entry id, marked handled when its row is opened */
    diedId?: string | null;
    created: number;
    /** last human prompt or Claude text/tool call, not file mtime; null when the transcript has none */
    lastActivity: number | null;
    /** the transcript was written by a subagent */
    sidechain: boolean;
    items: WorkItem[];
    /** its helpers (subagents) with a transcript of their own */
    agents?: { id: string; description: string; status: string }[];
    /** origin is the personal (hobby) GitHub account */
    hobby?: boolean;
    /** commits ahead of the upstream; null when there is no upstream */
    unpushed?: number | null;
    /** a work repo on its default branch: Homebase never pushes it, so the Push button is hidden */
    pushBlocked?: boolean;
    manual?: boolean; // a manual-mode chat (server/manual.mjs)
    /** context window used, % (from the status-line dump); null when there is none */
    context: number | null;
    /** context window size in tokens (from the same dump); null when unknown */
    contextSize?: number | null;
    /** when that dump was written, ms */
    contextAt: number | null;
    tmux?: string;
    /** a work helper in its own chat (server/helpers.mjs): the chat that started it; absent otherwise */
    parentId?: string;
    /** that helper: closed is the composer's note once it is closed (read-only), else null; tmux is its cc-<id8> */
    helper?: { closed: string | null; tmux: string };
    /** watched instruction files changed since this chat's Claude started; absent when none */
    rulesStale?: string[];
    /** newest mtime among them, ms; a dismissed notice stays hidden until this grows */
    rulesAt?: number;
    /** the message "Load new rules" sends: re-read these files now */
    rulesReload?: string;
    /** set on the session a /clear started: the id of the one it replaced */
    clearedFrom?: string;
}

type Column = 'needs-you' | 'doing' | 'unknown' | 'review' | 'ready' | 'finished' | 'done' | 'closed' | 'idle';

interface Pipeline { status: string; url?: string; at?: string }

interface PrState {
    state: string;
    title: string;
    branch: string;
    reviewers: string[];
    ready: boolean;
    approved?: boolean;
    /** GitLab: who approved it, asked for every open non-draft MR GitLab doesn't already call unapproved */
    approvedBy?: string[];
    /** its comments could never be read, so the row is Not checked */
    unread?: boolean;
    /** GitLab's detailed_merge_status */
    mergeStatus?: string | null;
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
    updatedAt: number;
    /** when the MR was opened on the forge, for the row's fixed order */
    createdAt?: number | null;
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

interface RowAction {
    label: string;
    message: string;
    /** a review chat's button: Review starts the reviewer, Reviewing… waits, Send findings types its last message into the row's chat (the others send `message` as is) */
    kind?: 'review' | 'reviewing' | 'findings' | 'merge' | 'rebase' | 'unqueue' | 'helper'; // helper (`helper`: 'conflict' | 'failing' | 'changes'): starts a fresh helper on the MR's branch (POST /api/action, server/actions.mjs) instead of typing into its chat; rebase: Homebase asks GitLab to rebase an MR that is only behind (POST /api/rebase), the chat message is its fallback; merge: puts the GitLab MR in Homebase's merge queue (POST /api/queue), with no confirm (the page shows it queued before the POST answers), which rebases it if behind and merges it; unqueue takes it out (POST /api/queue?on=0)
    helper?: 'conflict' | 'failing' | 'changes';
    hint?: string; // the tooltip, when the message is too long for one
    reviewerId?: string;
}

interface Activity { id: string; description: string; status: string; tldr: string | null }

/** findings: what the row offers once its review chat is done (server/reviews.mjs reviewFindings); `sent` for the current head. */
interface ReviewFindings { kind: 'send' | 'approve' | 'sent'; message?: string; sessionId?: string }
interface ReviewRequest { url: string; iid: number; title: string; project: string; author: string; draft: boolean; updatedAt: number; sha: string | null; pipeline: Pipeline | null; findings?: ReviewFindings | null }

interface WorkItem {
    key: string;
    project: string;
    sessionId: string;
    title: string;
    manual?: boolean; // its chat is in manual mode
    firstTitle?: string | null;// the agent's spawn description, when a later SendMessage renamed the row
    pr: string | null;
    forgeError?: string | null; // why the last MR/PR lookup (or its comments, "comments: …") failed, in plain words; the last good data is kept
    prState: PrState | null;
    column: Column;
    /** the row's computed state as the user saw it; a pin (POST /api/pins) holds only while it is unchanged */
    fp?: string;
    /** the user moved the row to `column` by hand; `autoColumn` is where it would be otherwise */
    pinned?: boolean;
    autoColumn?: Column;
    /** index into LIFECYCLE */
    stage: number;
    stageLabel: string;
    agentStatus: string | null;
    /** the helper behind the row, for Step in; null when it has no transcript left */
    agentId: string | null;
    agentDescription: string | null;
    /** the helper is a chat of its own (server/helpers.mjs): Step in opens it, and the row can stop it; null otherwise */
    helperSession?: string | null;
    /** the chat waiting on you about this MR (its question's lead MR is it): the row is in Needs you and stands for that chat's question */
    askedBy?: string | null;
    helperClosed?: boolean;
    /** when a running agent started its current step (`next` names it); null otherwise */
    stepAt: number | null;
    updated: number;
    /** Its fixed order in its group: an MR's creation on the forge (else when Homebase first saw it), a helper's start. */
    since: number | null;
    branch: string;
    worktreePath: string | null;
    tldr: string | null;
    body: string;
    files: string[];
    activity: Activity[];
    requested: { at: number; text: string } | null;
    state?: { kind: string; reason: string };
    next: string;
    action: RowAction | null;
    /** a quiet line in the button's slot when there is no button, e.g. 'Reviewed twice' */
    note?: string | null;
    gate: Gate | null;
    /** the Stop hook's last run of the project's check commands in the row's chat (server/checks.mjs) */
    checks: { state: 'pass' | 'fail' | 'running'; at: number } | null;
    tokens: string | null;
    tokensTitle: string | null;
    time: string | null;
    milestone: Milestone | null;
    comments: Comments | null;
    /** client-only: optimistic "sent" mark (list.js) */
    sent?: number;
}

// ---- /api/transcript ----

interface Answer { text: string; at?: string; queued?: boolean; sending?: boolean; error?: string; unconfirmed?: boolean }

interface ChatItem {
    role: 'user' | 'assistant' | 'tools' | 'error' | 'compact' | 'command';
    /** a 'command' item: the slash command or `! bash` line whose panel or output `text` is, and (client-only) what to do next */
    cmd?: string;
    hint?: string;
    text: string;
    /** a Claude reply's id: its newest transcript entry's uuid */
    id?: string;
    at?: string;
    topic?: string | null;
    needsYou?: boolean;
    tldr?: string | null;
    interrupted?: boolean;
    /** a tools line with no edits or agents, hidden as noise */
    quiet?: boolean;
    /** how many of a tools line's calls failed (never quiet then) */
    failed?: number;
    /** a finished agent's result, folded under its line */
    detail?: string;
    /** a tools line for one command that pushes, merges or forces (summaries.mjs RISKY), always shown */
    risky?: boolean;
    /** queued in the server's send queue */
    pending?: boolean;
    replies?: string[];
    /** the choices in a message that asks something (an exact substring of text), shown outside the fold */
    options?: string;
    /** what the reply says still waits on the user (its "Waiting on you: …"), kept after the user says something else */
    waiting?: string;
    /** waiting split into its question, the context before it and its numbered options (asks.mjs waitingAsk) */
    ask?: { question: string; context: string; options: { label: string; desc: string }[] };
    /** the reply's "**Heads-up:** …" line, shown outside the fold in the warn colour */
    headsUp?: string;
    answer?: Answer;
    /** a button's message (web/src/lib/canned.ts): the line shown in place of its text */
    label?: string;
    // client-only (chat.js outbox and decorations)
    sending?: boolean;
    error?: string;
}

interface Transcript {
    items: ChatItem[];
    more?: boolean; // older messages exist that are not in items
    capped?: boolean; // older messages exist, but before the part of the transcript the server reads
    asking: string | null;
    questions: { question: string; options: string[]; descriptions?: string[] }[] | null;
    /** the permission prompt is a background helper's, shown on this chat's pane (answerable only there) */
    helperAsking?: boolean;
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
    forge?: 'GitLab' | 'GitHub';
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

// ---- /api/limits, /api/refresh ----

interface LimitWindow { used: number; resetsAt: number }
interface Limits { fiveHour?: LimitWindow; sevenDay?: LimitWindow; updated?: number }
interface RefreshState { refreshing: boolean; lastRefreshedAt: number }

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

// ---- /api/diff (server/diff.mjs) ----

interface DiffFile { path: string; status: string; add: number | null; del: number | null; binary: boolean }
/** repo is null when the folder is gone or not in a git repo; the other fields are then missing */
interface DiffView { repo: string | null; branch?: string; base?: { ref: string; sha: string } | null; uncommitted?: DiffFile[]; committed?: DiffFile[]; truncated?: boolean }
/** one file: its unified diff, an untracked file's text, or why there is none */
interface DiffBody { diff?: string; text?: string; binary?: boolean; tooLarge?: boolean }
