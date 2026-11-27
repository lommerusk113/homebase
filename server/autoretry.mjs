// Auto-retry and auto-nudge, from Contado: a chat, helper or subagent that stopped on a transient API error (overloaded, server error,
// "computer went to sleep") gets the canned Continue after 30 s, 2 min, 5 min; the count resets after 10 min without a failure, and
// after the third try the row stays Needs you. A rate-limit stop is retried only when its reset time is in the error text, once, just
// after it. A silent subagent gets the Continue nudge at most 3 times, 60 s apart. Run on every poll from sessions.mjs; state in
// retries.json in the Homebase dir so a restart does not start the count again. Every send goes through autosend.mjs (logged as Homebase's).
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { textOf } from './entries.mjs';
import { autoSend, canAutoSend } from './autosend.mjs';
import { canned } from '../web/src/lib/canned.ts';

export const RETRY_DELAYS = [30_000, 120_000, 300_000];
export const RESET_MS = 10 * 60_000;
export const NUDGES = 3, NUDGE_GAP_MS = 60_000, AFTER_RESET_MS = 30_000;

export const retries = new Map(); // candidate key -> { kind, n, failedAt, sentFor, at }
let savedIn = null;
let saving = Promise.resolve();

const clock = at => new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** When a rate-limit message says it resets ("resets 5pm", "resets 3:40 PM (Europe/Oslo)"), the next such time after `at` in ms; null if unknown or in another zone. */
export function limitReset(text, at, zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {

    const m = String(text).match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
    if (!m || !Number.isFinite(at) || (m[4] && m[4] !== zone)) {
        return null;
    }
    const hour = Number(m[1]) % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    const d = new Date(at);
    d.setHours(hour, Number(m[2] ?? 0), 0, 0);

    return d.getTime() > at ? d.getTime() : d.getTime() + 864e5;
}

/** An API error entry as { kind: 'transient' | 'rate-limit' | 'other', resetAt }: only a transient one is worth retrying. */
export function apiErrorOf(e) {

    const text = textOf(e);
    if (e.error === 'rate_limit' || /rate.?limit|hit your limit|usage limit/i.test(text)) {
        return { kind: 'rate-limit', resetAt: limitReset(text, Date.parse(e.timestamp)) };
    }
    if (['overloaded', 'server_error'].includes(e.error) || e.apiErrorStatus >= 500 || /overloaded|computer went to sleep|API Error: 5\d\d|server error/i.test(text)) {
        return { kind: 'transient', resetAt: null };
    }

    return { kind: 'other', resetAt: null };
}

/**
 * What one stopped chat/agent gets now, from its saved state st (or undefined): { do: 'send' | 'wait' | 'give-up', n, retry }.
 * c: { kind: 'transient' | 'rate-limit' | 'silent', failedAt, resetAt }. retry is what the row shows: { text } while it is on its way,
 * { gaveUp } once it is out of tries.
 */
export function retryStep(st, c, now) {

    if (c.kind === 'silent') {
        const n = st?.n ?? 0;
        if (n >= NUDGES) {
            return { do: 'give-up', n, retry: { gaveUp: `nudged ${NUDGES} times` } };
        }

        return { do: n === 0 || now - st.at >= NUDGE_GAP_MS ? 'send' : 'wait', n: n + 1, retry: { text: `Nudging (${n + 1}/${NUDGES})…` } };
    }
    if (st?.sentFor === c.failedAt) { // already sent for this failure: the chat has not reacted yet
        return { do: 'wait', n: st.n, retry: { text: c.kind === 'rate-limit' ? `Retrying after the limit resets (${clock(c.resetAt)})…` : `Retrying (${st.n}/${RETRY_DELAYS.length})…` } };
    }
    if (c.kind === 'rate-limit') {
        return { do: now >= c.resetAt + AFTER_RESET_MS ? 'send' : 'wait', n: 1, retry: { text: `Retrying after the limit resets (${clock(c.resetAt)})…` } };
    }
    const n = st && c.failedAt - st.failedAt <= RESET_MS ? st.n : 0;
    if (n >= RETRY_DELAYS.length) {
        return { do: 'give-up', n, retry: { gaveUp: `retried ${RETRY_DELAYS.length} times` } };
    }

    return { do: now >= c.failedAt + RETRY_DELAYS[n] ? 'send' : 'wait', n: n + 1, retry: { text: `Retrying (${n + 1}/${RETRY_DELAYS.length})…` } };
}

// What may be continued on its own: a chat (a main chat or a helper's own) whose last turn is a retryable API error, and a subagent
// that stopped on one or went silent. Only in a chat with a live Claude (the registry knows it): never one that would be started anew.
function candidates(list, live) {

    const out = [];
    for (const s of list) {
        if (!live?.has(s.id) || s.status === 'working' || s.helper?.closed) {
            continue;
        }
        const e = s.apiError;
        if (e && (e.kind === 'transient' || (e.kind === 'rate-limit' && e.resetAt))) {
            const helperRow = list.flatMap(p => p.agents ?? []).find(a => a.helperSession === s.id);
            out.push({ key: s.id, kind: e.kind, failedAt: e.at, resetAt: e.resetAt, sessionId: s.id, title: s.title ?? s.topic ?? 'this chat', marks: [s, helperRow].filter(Boolean) });
        }
        for (const a of s.agents ?? []) {
            const silent = a.stopReason === 'silent', transient = a.stopReason === 'api-error' && a.errorKind === 'transient';
            if (!a.helperSession && a.status === 'stopped' && (silent || transient)) {
                out.push({ key: `${s.id}/${a.id}`, kind: silent ? 'silent' : 'transient', failedAt: a.updated, sessionId: s.id, title: a.description ?? 'agent', marks: [a] });
            }
        }
    }

    return out;
}

/**
 * One pass over the sessions (before their rows are built): marks each candidate's `retry` for its row and sends the Continue that is
 * due. Never throws; a send that fails counts as the try, so a stuck chat gets at most the schedule's worth.
 */
export function autoContinue(list, live, now = Date.now(), { send = autoSend, ready = canAutoSend, map = retries, save = saveRetries } = {}) {

    const seen = new Set();
    let changed = false;
    for (const s of list) { // marks are rebuilt every pass: a transcript's cached agent would keep an old one
        delete s.retry;
        s.agents?.forEach(a => { delete a.retry; });
    }
    for (const c of candidates(list, live)) {
        seen.add(c.key);
        const st = map.get(c.key), step = retryStep(st, c, now);
        c.marks.forEach(m => { m.retry = step.retry; });
        if (step.do !== 'send' || !ready()) {
            continue;
        }
        map.set(c.key, { kind: c.kind, n: step.n, failedAt: c.failedAt, sentFor: c.failedAt, at: now });
        changed = true;
        send(c.sessionId, canned('continue', c.title).message).then(
            () => console.log(`auto-continue ${step.n}: ${c.kind} on ${c.key.slice(0, 8)} (${c.title})`),
            e => console.error(`auto-continue ${c.key.slice(0, 8)}: ${e.message}`)
        ).catch(() => {});
    }
    // a silent agent that runs again starts over; a failure count only after its quiet 10 minutes
    for (const [key, st] of map) {
        if (!seen.has(key) && (st.kind === 'silent' || now - st.at > RESET_MS)) {
            map.delete(key);
            changed = true;
        }
    }
    if (changed) {
        save(map).catch(() => {});
    }
}

export function loadRetries(dir, map = retries) {

    savedIn = dir;
    try {
        for (const [key, st] of Object.entries(JSON.parse(readFileSync(join(dir, 'retries.json'), 'utf8')))) {
            if (Number.isFinite(st?.at) && Number.isFinite(st.n)) {
                map.set(key, st);
            }
        }
    } catch {} // missing or broken: the count starts again
}

export function saveRetries(map = retries, dir = savedIn) {

    if (!dir) {
        return Promise.resolve();
    }
    saving = saving.catch(() => {}).then(async () => {
        const file = join(dir, 'retries.json'), tmp = `${file}.tmp`;
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
        await rename(tmp, file);
    });

    return saving;
}
