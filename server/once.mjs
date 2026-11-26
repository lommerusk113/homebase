import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// The double-send guard for a row's button: the browser sends once=<rowKey>, and a repeat is refused until the row's
// state kind changes or ONCE_MS pass. Covers a second click after the outbox cleared and a second device.
export const ONCE_MS = 120_000;
export const sentRows = new Map(); // rowKey -> { at, kind }; items.mjs holds a clicked row in Doing while its kind is the same

/** True and remembered for a first send of this key at this kind; false for a repeat. release() forgets it when the send failed. */
export function claim(map, key, kind, now = Date.now()) {

    const prev = map.get(key);
    if (prev && prev.kind === kind && now - prev.at < ONCE_MS) {
        return false;
    }
    map.set(key, { at: now, kind });

    return true;
}

export const release = (map, key) => map.delete(key);

// A click holds its row in Doing this long at most (items.mjs); kept in sent.json in the Homebase dir so a restart keeps it.
export const HOLD_MS = 30 * 60_000;

export function loadSent(dir, map = sentRows, now = Date.now()) {

    try {
        for (const [key, v] of Object.entries(JSON.parse(readFileSync(join(dir, 'sent.json'), 'utf8')))) {
            if (Number.isFinite(v?.at) && now - v.at < HOLD_MS) {
                map.set(key, { at: v.at, kind: v.kind ?? null });
            }
        }
    } catch {} // missing or broken: no holds, rows show their buttons
}

export async function saveSent(dir, map = sentRows, now = Date.now()) {

    const keep = Object.fromEntries([...map].filter(([, v]) => now - v.at < HOLD_MS));
    const file = join(dir, 'sent.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(keep), { mode: 0o600 });
    await rename(tmp, file);
}
