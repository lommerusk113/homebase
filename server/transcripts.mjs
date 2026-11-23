// GET /api/transcript: one chat's feed, question and turn state. Re-exports the transcript modules (entries, summaries,
// feed, asks, turns, usage) for code that still imports them from here.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, liveSessions } from './entries.mjs';
import { FEED_ITEMS, feedTail } from './feed.mjs';
import { askMarker, turnState, pendingQuestion, pendingAsk } from './turns.mjs';

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
    const turn = turnState(entries, Date.now() - st.mtimeMs, marker, live);

    return { items, more, capped, asking: pendingQuestion(entries, marker), questions: pendingAsk(entries, marker), working: turn.state === 'working', stuck: turn.state === 'stuck', since: turn.since };
}
