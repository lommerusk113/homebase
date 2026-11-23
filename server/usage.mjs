// Token usage of a transcript, read incrementally by byte offset, and the duration and token formatters.
import { open, stat } from 'node:fs/promises';

export const usageCache = new Map(); // subagent transcript path -> { offset, byId, first, last, prev, active, totals }
// A gap between two transcript entries longer than this is idle (a helper resumed days later), not work.
export const IDLE_CUTOFF_MS = 10 * 60_000;
export const USAGE_KEYS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' };

// Folds complete JSONL lines into u. Streamed chunks repeat a message id with the same usage, so the last one per id wins.
export function addUsage(u, text) {

    for (const line of text.split('\n')) {
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const t = Date.parse(e.timestamp);
        if (t) {
            u.first = Math.min(u.first ?? t, t);
            u.last = Math.max(u.last ?? t, t);
            const gap = t - (u.prev ?? t);
            u.active = (u.active ?? 0) + (gap >= 0 && gap < IDLE_CUTOFF_MS ? gap : 0);
            u.prev = t;
        }
        if (e.type === 'assistant' && e.message?.usage) {
            u.byId.set(e.message.id ?? Symbol(), e.message.usage);
        }
    }

    u.totals = Object.fromEntries(Object.entries(USAGE_KEYS).map(([k, f]) => [k, [...u.byId.values()].reduce((n, x) => n + (x[f] ?? 0), 0)]));

    return u;
}

// Token totals and first/last timestamp and active time (gaps under IDLE_CUTOFF_MS) of a transcript, reading only the bytes appended since the last call.
export async function readUsage(path, size) {

    size ??= (await stat(path)).size;
    let u = usageCache.get(path);
    if (!u || size < u.offset) {
        u = { offset: 0, byId: new Map(), first: null, last: null, prev: null, active: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        usageCache.set(path, u);
    }

    if (size > u.offset) {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(size - u.offset);
            const { bytesRead } = await fh.read(buf, 0, buf.length, u.offset);
            // ponytail: a partial trailing line isn't buffered; the offset stops before it and the line is re-read once complete
            const end = buf.lastIndexOf(10, bytesRead - 1) + 1;
            if (end) {
                addUsage(u, buf.toString('utf8', 0, end));
                u.offset += end;
            }
        } finally {
            await fh.close();
        }
    }

    return { ...u.totals, first: u.first, last: u.last, active: u.active };
}

// "14m", "1h 05m"
export function formatDuration(ms) {

    const m = Math.round(ms / 60_000);

    return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "1.2M tok"
export function formatTokens(n) {

    const [d, unit] = n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'k'] : [1, ''];

    return `${+(n / d).toFixed(n >= 10 * d || d === 1 ? 0 : 1)}${unit} tok`;
}
