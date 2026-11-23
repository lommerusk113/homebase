// Rate limits for GET /api/limits, from the status-line dumps scripts/statusline.sh writes.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// HOMEBASE_STATUSLINE_DIR lets a test server read sample dumps instead of the real folder.
const STATUS_DIR = process.env.HOMEBASE_STATUSLINE_DIR ?? join(process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase'), 'statusline');

// Status-line JSON -> { fiveHour, sevenDay: { used, resetsAt } }; windows past their reset are dropped, as Claude Code does.
export function limitsOf(j, now = Date.now()) {

    const win = w => (typeof w?.used_percentage === 'number' && w.resets_at * 1000 > now ? { used: w.used_percentage, resetsAt: w.resets_at * 1000 } : null);
    const out = { fiveHour: win(j?.rate_limits?.five_hour), sevenDay: win(j?.rate_limits?.seven_day) };

    return out.fiveHour || out.sevenDay ? out : null;
}

// Highest used % seen per window, keyed by name and resets_at. Dumps are per session and can be stale, so a dump
// must never lower the number within a window; a new resets_at starts fresh. Expired windows are dropped.
// Only dumps on the newest five-hour window count, and a new five-hour window forgets the weekly peak: a refill
// starts one and lowers the weekly number, which the sessions still on the old window don't know yet.
export function peakLimits(peaks, dumps, now = Date.now()) {

    const live = dumps.map(j => limitsOf(j, now)).filter(Boolean);
    const newest = Math.max(0, ...live.map(l => l.fiveHour?.resetsAt ?? 0));
    const known = Math.max(0, ...[...peaks.keys()].filter(k => k.startsWith('fiveHour:')).map(k => Number(k.split(':')[1])));
    if (newest > known) {
        [...peaks.keys()].filter(k => k.startsWith('sevenDay:')).forEach(k => peaks.delete(k));
    }
    const window = Math.max(newest, known);
    for (const l of window ? live.filter(l => l.fiveHour?.resetsAt === window) : live) {
        for (const [name, w] of Object.entries(l)) {
            if (w) {
                const k = `${name}:${w.resetsAt}`;
                peaks.set(k, Math.max(peaks.get(k) ?? 0, w.used));
            }
        }
    }
    for (const k of peaks.keys()) {
        if (Number(k.split(':')[1]) <= now) {
            peaks.delete(k);
        }
    }

    const current = name => {
        const resets = [...peaks.keys()].filter(k => k.startsWith(`${name}:`)).map(k => Number(k.split(':')[1]));
        if (!resets.length) {
            return null;
        }
        const resetsAt = Math.max(...resets);

        return { used: peaks.get(`${name}:${resetsAt}`), resetsAt };
    };
    const out = { fiveHour: current('fiveHour'), sevenDay: current('sevenDay') };

    return out.fiveHour || out.sevenDay ? out : null;
}

// A session's context window use from its own dump (<session id>.json): { percent, size: window tokens or null, at: dump mtime ms }, or null when
// there is none yet (no status line has run for it) or it carries no percentage.
export async function contextOf(id, dir = STATUS_DIR) {

    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) {
        return null;
    }
    try {
        const path = join(dir, `${id}.json`);
        const w = JSON.parse(await readFile(path, 'utf8'))?.context_window, percent = w?.used_percentage;
        const size = typeof w?.context_window_size === 'number' ? w.context_window_size : null;

        return typeof percent === 'number' ? { percent, size, at: (await stat(path)).mtimeMs } : null;
    } catch {
        return null;
    }
}

const limitPeaks = new Map();

// Rate limits from every status-line dump (written by scripts/statusline.sh), plus when the newest one was written.
// ponytail: one file per session accumulates in STATUS_DIR and all are read each poll; prune old ones if the folder ever gets big
export async function limits() {

    let names;
    try {
        names = (await readdir(STATUS_DIR)).filter(n => n.endsWith('.json'));
    } catch {
        return null;
    }

    const dumps = [];
    let updated = 0;
    for (const n of names) {
        try {
            const path = join(STATUS_DIR, n);
            const j = JSON.parse(await readFile(path, 'utf8'));
            if (limitsOf(j)) {
                dumps.push(j);
                updated = Math.max(updated, (await stat(path)).mtimeMs);
            }
        } catch {}
    }
    const out = peakLimits(limitPeaks, dumps);

    return out && { ...out, updated };
}
