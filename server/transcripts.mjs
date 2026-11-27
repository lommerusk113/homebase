// GET /api/transcript: one chat's feed, question and turn state. Re-exports the transcript modules (entries, summaries,
// feed, asks, turns, usage) for code that still imports them from here.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, liveSessions, tailOf } from './entries.mjs';
import { FEED_ITEMS, feedTail, chatFeed } from './feed.mjs';
import { askMarker, markIdle, turnState, pendingQuestion, pendingAsk, helperAsk } from './turns.mjs';

export * from './entries.mjs';
export * from './summaries.mjs';
export * from './feed.mjs';
export * from './asks.mjs';
export * from './turns.mjs';
export * from './usage.mjs';

export async function transcript(dir, id, max) {

    if (!dir || !id || dir.includes('/') || id.includes('/')) {
        throw Object.assign(new Error('bad path'), { status: 400 });
    }
    const path = join(ROOT, dir, `${id}.jsonl`);
    if (!path.startsWith(ROOT + '/')) {
        throw Object.assign(new Error('bad path'), { status: 400 });
    }

    const st = await stat(path);
    const { items, more, capped, entries } = await feedTail(path, st, Math.min(Math.max(Math.trunc(Number(max)) || FEED_ITEMS, 1), 10_000));

    const live = await liveSessions();
    const marker = await askMarker(id, { live });
    await markIdle(entries, Date.now() - st.mtimeMs, live);
    const turn = turnState(entries, Date.now() - st.mtimeMs, marker, live);

    return { items, more, capped, asking: pendingQuestion(entries, marker), questions: pendingAsk(entries, marker), helperAsking: helperAsk(marker, entries), working: turn.state === 'working', stuck: turn.state === 'stuck', since: turn.since };
}

// GET /api/agent-feed: a helper's own conversation, in the transcript's shape. Both ids must be a session and one of its
// helpers from Homebase's own list, so the path is built from what the server found, never from the request.
export async function agentFeed(list, sessionId, agentId, max) {

    const s = list.find(x => x.id === sessionId), a = s?.items?.find(x => x.agentId && x.agentId === agentId); // the list's rows name each helper (raw agents are dropped from it)
    if (!a) {
        throw Object.assign(new Error('no such helper'), { status: 404 });
    }
    const path = join(ROOT, s.dir, a.agentSession ?? s.id, 'subagents', `${a.agentId}.jsonl`); // the session it started in, not the chat's current one after a /clear
    // a helper's transcript is all sidechain entries, which the chat feed leaves out: read them as the helper's own conversation
    // ponytail: the cached tail only (no deeper read for "Show earlier"), which is the last ~512 KB of the helper
    const st = await stat(path).catch(() => { throw Object.assign(new Error('the helper\'s transcript is gone'), { status: 404 }); });
    const entries = (await tailOf(path, st)).map(e => ({ ...e, isSidechain: false }));
    const feed = chatFeed(entries, Math.min(Math.max(Math.trunc(Number(max)) || FEED_ITEMS, 1), 10_000));
    const items = feed.items, more = feed.earlier > 0, capped = false;

    return { items, more, capped, asking: s.askingAgent === agentId ? s.question : null, questions: [], working: a.agentStatus === 'running', stuck: false };
}
