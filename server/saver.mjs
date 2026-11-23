// Token saver: when on, chats Homebase starts run their helpers (Agent tool) on Sonnet. One file, token-saver.md in the
// Homebase dir, is both the setting and what a running chat re-reads when it goes stale (rules.mjs watches it).
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SAVER_RULE = 'Token saver is on: start every helper (Agent tool) with model: sonnet, unless the user names another model.';
export const saverRules = on => (on ? SAVER_RULE : 'Token saver is off: pick helper models as usual.');

const dir = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
export const saverFile = (d = dir()) => join(d, 'token-saver.md');

export const saverOn = (d = dir()) => {
    try {
        return readFileSync(saverFile(d), 'utf8').trim() === SAVER_RULE;
    } catch {
        return false;
    }
};

// body: JSON { on: boolean }. Throws 400 for anything else.
export async function saveSaver(body, d = dir()) {

    let b;
    try {
        b = JSON.parse(body);
    } catch {}
    if (typeof b?.on !== 'boolean') {
        throw Object.assign(new Error('expected {on: boolean}'), { status: 400 });
    }

    const file = saverFile(d);
    await mkdir(d, { recursive: true });
    await writeFile(`${file}.tmp`, `${saverRules(b.on)}\n`, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
}
