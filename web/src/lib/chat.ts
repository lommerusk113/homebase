// What the chat shows about a turn: its status line, the open decision, the folded command runs, the model chip.
import { hoursMinutes, serverNow } from './time.ts';

export const NEEDS_ANSWER = 'Claude needs your answer';

/** Claude's newest reply when it says something still waits on the user (its "Waiting on you: …") and that isn't answered. */
export const openDecision = (d: { items?: ChatItem[] } | null | undefined): ChatItem | null => {
    const i = d?.items?.findLast(x => x.role === 'assistant');
    return i?.waiting && !i.answer && !i.error ? i : null;
};

// Chat status bar: a failed poll wins (never claim "Idle" on data we couldn't fetch), then asking over working
// (Claude waits on you); working counts from the turn start (`since`), else from your last message. Idle says whether
// Claude's last reply wants you (or its newest reply still waits on you, said since or not) and whether its agents
// still work, from the session `s`. serverError: the failed poll was Homebase itself failing, not the connection.
export const chatStatus = (d: (Partial<Transcript> & { error?: boolean }) | null, now = serverNow(), s: Pick<Session, 'needsYou' | 'step'> | null = null, serverError = false) => {
    if (d?.error) {
        return { kind: 'error', text: serverError ? 'Homebase hit an error (see its log) — retrying…' : 'Can’t reach Homebase — reconnecting…' };
    }
    if (d?.asking) {
        return { kind: 'asking', text: 'Claude is asking — see the question above' };
    }
    if (d?.stuck && !d.working) {
        return { kind: 'stuck', text: 'No activity for 30 min — Claude may be stuck' };
    }
    if (!d?.working) {
        return { kind: 'idle', text: s?.needsYou || openDecision(d) ? NEEDS_ANSWER : 'Claude is done' };
    }
    const at = d.since ?? Date.parse(d.items?.findLast(i => i.role === 'user' && !i.pending)?.at as string);
    const m = (now - at) / 60000 | 0;

    return { kind: 'working', text: `Claude is working…${m > 0 ? ` · ${hoursMinutes(m)}` : ''}${s?.step ? ` · ${s.step}` : ''}` };
};

/** Context window use, as a level for the gauge colour: amber from 60%, red from 85%. */
export const ctxLevel = (p: number): '' | 'warn' | 'hot' => (p >= 85 ? 'hot' : p >= 60 ? 'warn' : '');

// Commands with nothing between them show as one line: the run starting at n, or [] where n is inside one. One with
// a hint (a picker left open) stays its own line, so the hint is never folded away.
export function commandRun(items: ChatItem[], n: number): ChatItem[] {
    const plain = (i?: ChatItem) => i?.role === 'command' && !i.hint;
    if (!plain(items[n])) {
        return [items[n]];
    }
    const end = items.findIndex((i, k) => k > n && !plain(i));

    return plain(items[n - 1]) ? [] : items.slice(n, end < 0 ? items.length : end);
}

/** A transcript model id (claude-opus-5-5) as its family name for the chat's model chip; null for none or <synthetic>. */
export const modelName = (id?: string | null): string | null => {
    const m = /opus|sonnet|haiku|fable/i.exec(id ?? '')?.[0].toLowerCase();

    return m ? m[0].toUpperCase() + m.slice(1) : null;
};
