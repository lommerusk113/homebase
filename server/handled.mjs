// Replies the user marked as handled (POST /api/handled): a "needs you" Claude got wrong. In handled.json in the Homebase
// dir, so the board, the chat, paired devices and push agree. The newest MAX are kept.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_ID } from './turns.mjs';
import { handled } from './feed.mjs';
import { keepAside } from './account.mjs';

const MAX = 500;
let list = []; // "sessionId/replyId", oldest first

function keep(next) {

    list = next;
    handled.clear();
    for (const key of list) {
        handled.add(key.split('/')[1]);
    }
}

// At server start: what was saved, or nothing when the file is missing or broken (a broken one is logged and set aside).
export function loadHandled(dir) {

    let saved;
    try {
        saved = JSON.parse(readFileSync(join(dir, 'handled.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'handled.json'), e.message, 'replies marked as handled may show as needing you again');
        }
    }
    const ok = key => typeof key === 'string' && key.split('/').length === 2 && key.split('/').every(id => SESSION_ID.test(id));
    keep(Array.isArray(saved) ? saved.filter(ok).slice(-MAX) : []);
}

// replyId: the feed item's id. Throws 400 for ids that are not UUIDs.
export async function markHandled(dir, sessionId, replyId) {

    if (!SESSION_ID.test(sessionId ?? '') || !SESSION_ID.test(replyId ?? '')) {
        throw Object.assign(new Error('expected a session id and a reply id'), { status: 400 });
    }
    const key = `${sessionId}/${replyId}`, next = [...list.filter(k => k !== key), key].slice(-MAX);

    const file = join(dir, 'handled.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
    keep(next);
}
