// What the board's rows are made of, and its attention transitions.
import { freshComments } from './comments.ts';
import { excerpt } from './text.ts';
import { ago } from './time.ts';
import { waitsOnYou } from './waiting.ts';

// A pipeline as the CI pill shows it: ✓ passed, ✗ failed, ● running/pending, grey for the rest, with its tooltip; null without a pipeline.
const PIPE: Record<string, [string, string]> = { success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'], preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled'] };

export function pipeWords(p: Pipeline | null | undefined): { icon: string, label: string, tip: string } | null {
    if (!p?.status) {
        return null;
    }
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const when = p.at && ago(Date.parse(p.at));

    return { icon, label: `Pipeline ${word}`, tip: `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}` };
}

/** What the session is on: its newest reply's topic, else the start of its last prompt. */
export function sessionTopic(s: Pick<Session, 'topic' | 'lastPrompt'>): string {
    if (s.topic) {
        return s.topic;
    }
    return excerpt(s.lastPrompt) || 'No prompt yet';
}

// The issues (#N) a chat's running or queued prompts name.
const askedIssues = (s: Session): string[] => [...new Set([s.status === 'working' ? s.now : null, ...(s.queued ?? [])].flatMap(t => [...(t ?? '').matchAll(/(?<![\w&!#])#(\d+)\b/g)].map(m => m[1])))];

// A work item is on issue n: its MR's issue, "#n" in its title, or a branch named "n-…".
const covers = (x: WorkItem, n: string): boolean => String(x.prState?.issue ?? '') === n || new RegExp(`#${n}(?!\\d)`).test(x.title ?? '') || !!x.branch?.startsWith(`${n}-`);

/** Issues (#N) the session's running or queued prompts name that no work item covers yet: placeholder rows in Doing. items: the project's items. */
export function startingIssues(s: Session, items: WorkItem[]): string[] {
    return askedIssues(s).filter(n => !items.some(x => covers(x, n)));
}

// Who already works on issue n in these sessions (one project's): the work item on it (not one whose MR is merged or was closed),
// else the chat whose running or queued prompt names it. null when nobody does.
export function issueWork(n: string, sessions: Session[]): { sessionId: string | null, key: string | null } | null {
    const item = sessions.flatMap(s => s.items || []).find(x => x.column !== 'done' && x.column !== 'closed' && covers(x, n));
    if (item) {
        return { sessionId: item.sessionId, key: item.key };
    }
    const s = sessions.find(s => askedIssues(s).includes(n));

    return s ? { sessionId: s.id, key: null } : null;
}

/** Rows' order in a group: newest work first, by when the row first appeared, never by its last activity, so a row never moves inside its group. */
export const byStart = (a: Pick<WorkItem, 'since' | 'updated' | 'key'>, b: Pick<WorkItem, 'since' | 'updated' | 'key'>): number => (b.since ?? b.updated) - (a.since ?? a.updated) || a.key.localeCompare(b.key);

const SHORT_WORDS = 3;

/** "project · Now: <step> · for 2m" for a working main chat; the time is since its newest tool call, else its turn start. */
export function workingLine(s: Session): string {
    const t = ago(s.stepAt ?? s.since ?? s.lastActivity ?? s.updated);
    return `${s.project} · Now: ${s.step || s.topic || 'thinking'}${t === 'now' ? '' : ` · for ${t}`}`;
}

/** What a working chat is on: the request its turn handles (no pasted image paths), else its newest reply's topic, else its title. */
export function workingTitle(s: Session): string {
    const asked = excerpt((s.now ?? '').replace(/\[Image: [^\]]*\]/g, ''), 100);
    // a short answer ("do it", "yes go ahead") says nothing on its own: the reply it answers names the work
    const short = asked.split(' ').length <= SHORT_WORDS;

    return (short && s.topic) || asked || s.topic || s.title || sessionTopic(s);
}

/** "all waiting on Ann" when every row's next step is the same "Waiting for review by Ann", else ''. */
export function reviewNote(list: WorkItem[]): string {
    const m = list[0]?.next?.match(/^Waiting for review by (.+)$/);

    return m && list.every(x => x.next === list[0].next) ? `all waiting on ${m[1]}` : '';
}

// Transitions into an attention state since the previous poll, at most one per item, plus a comment event per item with
// comments newer than both its seen time and the previous poll's newest. No previous poll (or comments not loaded then), no events.
export function attentionEvents(prevItems: WorkItem[] | undefined, nextItems: WorkItem[], seen: (x: WorkItem) => number = () => 0): AttentionEvent[] {
    if (!prevItems) {
        return [];
    }
    const before = new Map(prevItems.map(x => [x.key, x])), nextKeys = new Set(nextItems.map(x => x.key));
    const failing = (x: WorkItem | undefined) => x?.prState?.ci === 'failing';
    const events = nextItems.flatMap(x => {
        const p = before.get(x.key), was = p?.column;
        const kind = x.column === 'needs-you' && was !== 'needs-you' ? 'needs-you'
            : x.column === 'ready' && was !== 'ready' ? 'ready'
            : was === 'doing' && (x.column === 'review' || x.column === 'done' || x.column === 'closed' || x.column === 'finished') ? 'finished'
            : failing(x) && !failing(p) ? 'failing' : null;
        return kind ? [{ kind, item: x } as AttentionEvent] : [];
    });
    const comments = nextItems.flatMap(x => {
        const p = before.get(x.key);
        if (!x.pr || !x.comments || !p?.comments) {
            return [];
        }
        const fresh = freshComments(x.comments, Math.max(seen(x), Date.parse(p.comments.latestAt ?? '') || 0));
        return fresh.length ? [{ kind: 'comment', item: x, comments: fresh } as AttentionEvent] : [];
    });
    // one notification per item: a comment that moved it into needs-you is told as the comment
    const commented = new Set(comments.map(e => e.item!.key));
    // finished agents without an MR drop off the board
    return [...events.filter(e => !(e.kind === 'needs-you' && commented.has(e.item!.key))), ...comments, ...prevItems.filter(p => p.column === 'doing' && !nextKeys.has(p.key)).map(item => ({ kind: 'finished', item }) as AttentionEvent)];
}

/** Sessions that started waiting on the user (asking, or needs you) since the previous poll. No previous poll, no events. */
export function askingEvents(prev: Session[] | undefined, next: Session[]): AttentionEvent[] {
    if (!prev) {
        return [];
    }
    const was = new Set(prev.filter(waitsOnYou).map(s => s.id));

    return next.filter(s => waitsOnYou(s) && !was.has(s.id)).map(session => ({ kind: 'asking', session }) as AttentionEvent);
}

/** The review chat the Review button started for an MR (tmux cc-new-<project>-review-<iid>) while it, or a helper it started, works. */
export function reviewChat(sessions: Pick<Session, 'id' | 'tmux' | 'status' | 'parentId'>[], r: Pick<ReviewRequest, 'project' | 'iid'>) {

    const name = `cc-new-${r.project.split('/').pop()}-review-${r.iid}`.replace(/[^A-Za-z0-9._-]/g, '-');
    const chat = sessions.find(s => s.tmux === name);
    // ponytail: one level of helpers, as helpers start no helpers of their own
    const busy = chat && sessions.some(s => (s.id === chat.id || s.parentId === chat.id) && s.status === 'working');

    return busy ? chat : undefined;
}
