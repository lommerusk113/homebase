// What chats report about their work with `homebase status` (POST /api/status): session id -> { phase, mr, text, at }.
// Structured, so a row's group never depends on how an agent words its reply. In reports.json in the Homebase dir.
// items.mjs reads it (reportOn): doing counts while the chat works, needs-you while it doesn't; a newer prompt ends it.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const reports = new Map();
export const PHASES = ['doing', 'needs-you', 'done'];
const MAX = 200;

// An MR is its URL, !N or #N: anything else would be stored and never match a row.
const MR = /^(?:https:\/\/\S+|[!#]?\d+)$/;
const valid = r => !!r && PHASES.includes(r.phase) && (r.mr == null || (typeof r.mr === 'string' && r.mr.length <= 300 && MR.test(r.mr.trim())))
    && (r.text == null || typeof r.text === 'string');

let savedIn = null; // the Homebase dir loadReports read, where forgetReport writes

export function loadReports(dir) {

    savedIn = dir;
    reports.clear();
    try {
        for (const [id, r] of Object.entries(JSON.parse(readFileSync(join(dir, 'reports.json'), 'utf8')))) {
            if (valid(r) && Number.isFinite(r.at)) { // as report() checks it: a hand-edited entry never takes the board down
                reports.set(id, r);
            }
        }
    } catch {} // missing or broken: no reports, chats report again
}

// phase done forgets the chat's report. Throws 400 for an unknown phase or an over-long field.
export async function report(dir, sessionId, { phase, mr = null, text = null } = {}, now = Date.now()) {

    if (!valid({ phase, mr, text })) {
        throw Object.assign(new Error(`expected a phase (${PHASES.join(', ')}), an optional MR (URL, !N or #N) and text`), { status: 400 });
    }
    if (phase === 'done') {
        reports.delete(sessionId);
    } else {
        reports.set(sessionId, { phase, mr: mr?.trim() || null, text: text?.trim().slice(0, MAX) || null, at: now });
    }
    // ponytail: the newest MAX chats only
    const keep = [...reports].slice(-MAX);

    const file = join(dir, 'reports.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
    await rename(tmp, file);
}

// Forgets a chat's report (answered since, see sessions.mjs attachReports) and saves that, so a restart doesn't bring it back.
export function forgetReport(sessionId) {

    if (reports.delete(sessionId) && savedIn) {
        report(savedIn, sessionId, { phase: 'done' }).catch(() => {});
    }
}
