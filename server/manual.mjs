// Manual-mode chats: the user drives them. One session id per line in manual-chats (Homebase dir), so a resume keeps the rule.
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MANUAL_RULE = 'Manual mode: the user drives this chat. Discuss the issue with them, answer questions, and when they ask for a plan, use the grilling skill to interview them, and write the plan together. Change code, commit or start helpers only after they say go.';

const dir = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
const ids = () => {
    try {
        return new Set(readFileSync(join(dir(), 'manual-chats'), 'utf8').split('\n').filter(Boolean));
    } catch {
        return new Set();
    }
};

export const isManual = id => !!id && ids().has(id);

export function markManual(id) {

    if (/^[A-Za-z0-9-]{8,64}$/.test(id ?? '') && !isManual(id)) {
        mkdirSync(dir(), { recursive: true });
        appendFileSync(join(dir(), 'manual-chats'), `${id}\n`, { mode: 0o600 });
    }
}
