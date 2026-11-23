import { shallowRef } from 'vue';
import { commandRun, markHandled, openDecision, state, store } from 'old/core.js';
import { answerNote, clearState, feedPort, focusWanted, jumpToNeeds, refreshChat, showEarlier, type FeedInput } from 'old/chat.js';
import { useNotice } from '@/composables/useNotice';
import { pruneOutbox } from '@/composables/useOutbox';
import { seenOf } from '@/composables/useUnread';

/** The chips under a question, and the note that tells Claude which question they answer (none for the newest item). */
export interface Replies { labels: string[]; note?: string }
/** The New divider above the first item since the reader left. */
export interface NewRow { kind: 'new'; key: string }
/** Slash commands or `!` lines with nothing between them, as one line. */
export interface CommandsRow { kind: 'commands'; key: string; run: ChatItem[] }
/** A tools line, an API error or a compact divider. */
export interface LineRow { kind: 'line'; key: string; item: ChatItem }
export interface BubbleRow { kind: 'bubble'; key: string; item: ChatItem; prevTopic: string | null; latest: boolean; unread: boolean; replies: Replies | null }
export type FeedRow = NewRow | CommandsRow | LineRow | BubbleRow;
/** One drawing of the feed. first: this chat's first, stick: after a send (both end at the newest item). */
export interface FeedView { sid: string; chat: boolean; rows: FeedRow[]; head: 'hidden' | 'earlier' | 'capped' | null; welcome: string | null; first: boolean; stick: boolean }

const time = (i: ChatItem) => Date.parse(i.at ?? '');

// The transcript's items merged with this session's outbox, minus what Clear view hides.
function merge(s: Session, data: Transcript) {

    pruneOutbox(s.id, data.items);
    // a queued item whose Send now was clicked shows "sending…" until the queue entry resolves
    state.nudged = new Set(data.items.filter(i => i.pending).map(i => `${s.id}:${i.at}`).filter(k => state.nudged.has(k)));
    const items: ChatItem[] = data.items.map(i => (i.pending && state.nudged.has(`${s.id}:${i.at}`) ? { ...i, sending: true } : i));

    // placed by send time, so one sent before a queued message stays above it
    for (const o of state.outbox.filter(o => o.sid === s.id)) {
        // a chip answer shows as the question's tag, not a bubble
        const q = o.answerTo ? items.findIndex(x => x.role === 'assistant' && x.at === o.answerTo) : -1;
        if (q >= 0) {
            if (!items[q].answer) {
                items[q] = { ...items[q], answer: { text: o.text, sending: !o.error && !o.unconfirmed, error: o.error, unconfirmed: o.unconfirmed } };
            }
            continue;
        }
        const i = items.findIndex(x => time(x) > Date.parse(o.at));
        const r = o.result;
        const hint = r?.stuck ?? (r?.pick ? 'Pick this in the terminal, or type the command with its argument (e.g. /model opus)' : undefined);
        // a slash command that went through is its command line; one still sending or not sent keeps its bubble (Retry)
        const ran = r || (o.text.startsWith('/') && !o.sending && !o.error);
        items.splice(i < 0 ? items.length : i, 0, ran ? { role: 'command', text: r?.text ?? '', cmd: o.text, at: o.at, hint } : o);
    }

    // Clear view: items up to the stored cut-off stay hidden in Homebase only
    const cut = clearState(store.get(`cleared:${s.id}`));
    const hidden = items.findLastIndex(i => !!i.at && time(i) <= cut.at) + 1;
    // not the question that still waits for an answer (a decision, or reply chips nothing came after), nor a message that is not confirmed sent
    const open = openDecision({ items }), n = items.findLastIndex(i => !!i.replies?.length && !i.answer);
    const asks = n >= 0 && !items.slice(n + 1).some(x => x.role === 'user') ? items[n] : null;
    items.unshift(...items.splice(0, hidden).filter(i => i === open || i === asks || state.outbox.includes(i as OutboxItem)));

    return { items, hidden, cut };
}

// Quick replies under a Claude message that ends with a question and has no answer yet. The newest one waits for Claude
// to finish; an older one stays (the send just queues) and its chips carry a note naming the question; a message
// the user sent after it hides them. The open decision's chips are on the strip above the composer.
function repliesOf(data: Transcript, items: ChatItem[], n: number): Replies | null {

    const q = items[n], newest = n === items.length - 1;
    const unanswered = !q.answer || q.answer.error || q.answer.unconfirmed;
    if (data.asking || q === openDecision({ items }) || !q.replies?.length || !unanswered || (newest ? data.working : items.slice(n + 1).some(x => x.role === 'user'))) {
        return null;
    }

    return { labels: q.replies, note: answerNote(items, n) };
}

function rowsOf(v: FeedInput): FeedRow[] {

    const { items, data } = v, sid = v.sid ?? '';
    const seen = data ? seenOf(sid, items) : null;
    const latest = items.findLastIndex(i => i.role === 'assistant');
    const firstNew = items.findIndex(i => time(i) > (v.lastSeen ?? Infinity));
    const used = new Map<string, number>();
    // an item's own key, made unique where two items share a time
    const unique = (key: string) => {
        const n = used.get(key) ?? 0;
        used.set(key, n + 1);
        return n ? `${key}#${n}` : key;
    };
    let topic: string | null = null;

    return items.flatMap((item, n): FeedRow[] => {
        const prevTopic = topic;
        if (item.role === 'assistant') {
            topic = item.topic ?? null;
        }
        const run = item.role === 'command' ? commandRun(items, n) : [];
        if (run.length > 1 || (item.role === 'command' && !run.length)) { // commands in a row: one line where the run starts
            return run.length ? [{ kind: 'commands', key: unique(`${sid}:${item.at}:cmds`), run }] : [];
        }
        // unread: newer than the first load, not opened, and no message from the user after it
        const unread = !!seen && !!item.needsYou && time(item) > seen.at && !seen.keys.includes(`${sid}:${item.at}`) && !items.slice(n + 1).some(x => x.role === 'user');
        const row: FeedRow = item.role === 'command' ? { kind: 'commands', key: unique(`${sid}:${item.at}:${item.cmd}`), run }
            : item.role === 'tools' || item.role === 'error' || item.role === 'compact' ? { kind: 'line', key: unique(`${sid}:${item.at}:${item.role}`), item }
            : { kind: 'bubble', key: unique(`${sid}:${item.at}`), item, prevTopic, latest: n === latest, unread, replies: data ? repliesOf(data, items, n) : null };

        return n === firstNew ? [{ kind: 'new', key: 'new' }, row] : [row];
    });
}

const NO_CHAT = 'No session to chat with yet. Use ☰ → Open existing folder… to start one in a project, or ☰ → New project.';
const view = shallowRef<FeedView>({ sid: '', chat: false, rows: [], head: null, welcome: null, first: true, stick: false });
let earlier = false; // "Show earlier" was clicked: the next drawing keeps the view where it was

function show(v: FeedInput): void {

    const rows = rowsOf(v), { data, hidden = 0 } = v;
    const head = !data ? null : hidden && !v.cutFresh ? 'hidden' : data.more && !hidden ? 'earlier' : data.capped && !hidden ? 'capped' : null;
    const empty = !data ? (v.starting ? 'Chat starting…' : NO_CHAT) : v.fresh ? 'New conversation — say something to Claude' : 'No messages yet. Send one below, or run `claude` in a terminal in this project.';
    view.value = { sid: v.sid ?? '', chat: !!data, rows, head, welcome: head || rows.length ? null : empty, first: !!v.first, stick: !!v.stick };
}

// the old page's refreshChat (chat.js) fetches the transcript and draws through these
feedPort.merge = merge;
feedPort.show = show;

/** The open chat's message list as the old page last drew it, and what its own buttons do. */
export function useFeed() {

    return {
        view,
        /** Clear view's "Show": the hidden items come back. */
        showHidden: () => {
            store.set(`cleared:${view.value.sid}`, '');
            refreshChat();
        },
        showEarlier: () => {
            earlier = true;
            showEarlier();
        },
        /** True once after "Show earlier". */
        takeEarlier: () => {
            const was = earlier;
            earlier = false;
            return was;
        },
        /** Scrolls to and focuses what needs the user. */
        jumpToNeeds: () => jumpToNeeds(),
        /** A "needs you" Claude got wrong: the reply stops needing you, here and on the board. */
        markHandled: (reply: string) => markHandled(view.value.sid, reply).then(refreshChat, err => useNotice().showError(err.message)),
        /** After a drawing: a question the keyboard asked for (Enter on a waiting row) takes the focus. */
        drawn: () => focusWanted(view.value.sid)
    };
}
