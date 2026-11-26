// Homebase's own housekeeping notes typed into a chat ("Load new rules", sent with housekeeping=1): session id -> their
// texts, in sends.json in the Homebase dir. A transcript prompt with one of those texts is Homebase's, not the user's
// answer: it ends no report and answers no question. Prompt text itself is never classified.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const sends = new Map();
const PER_CHAT = 20, CHATS = 200;
let savedIn = null;

export function loadSends(dir) {

    savedIn = dir;
    sends.clear();
    try {
        for (const [id, texts] of Object.entries(JSON.parse(readFileSync(join(dir, 'sends.json'), 'utf8')))) {
            if (Array.isArray(texts)) {
                sends.set(id, texts.filter(t => typeof t === 'string'));
            }
        }
    } catch {} // missing or broken: no notes known, so an old one counts as the user's
}

/** Notes text as a housekeeping send to the chat, before it is typed. */
export function logHousekeeping(sessionId, text, map = sends) {

    map.set(sessionId, [...(map.get(sessionId) ?? []), text.trim()].slice(-PER_CHAT));
    if (savedIn && map === sends) {
        saving = saving.catch(() => {}).then(async () => {
            const file = join(savedIn, 'sends.json'), tmp = `${file}.tmp`;
            await mkdir(savedIn, { recursive: true });
            await writeFile(tmp, JSON.stringify(Object.fromEntries([...sends].slice(-CHATS))), { mode: 0o600 });
            await rename(tmp, file);
        });
    }
}
let saving = Promise.resolve();

export const isHousekeeping = (sessionId, text, map = sends) => !!text && !!map.get(sessionId)?.includes(text.trim());
