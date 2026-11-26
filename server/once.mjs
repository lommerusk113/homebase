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
