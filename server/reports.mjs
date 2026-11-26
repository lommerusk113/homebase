// What chats report about their work with `homebase status` (POST /api/status): session id -> { phase, mr, text, at }.
// Structured, so a row's group never depends on how an agent words its reply. In reports.json in the Homebase dir.
// items.mjs reads it (reportOn): doing counts while the chat works, needs-you while it doesn't; a newer prompt ends it.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const reports = new Map();
export const PHASES = ['doing', 'needs-you', 'done'];
const MAX = 200;

export function loadReports(dir) {

    reports.clear();
    try {
        for (const [id, r] of Object.entries(JSON.parse(readFileSync(join(dir, 'reports.json'), 'utf8')))) {
            reports.set(id, r);
        }
    } catch {} // missing or broken: no reports, chats report again
}

// phase done forgets the chat's report. Throws 400 for an unknown phase or an over-long field.
export async function report(dir, sessionId, { phase, mr = null, text = null } = {}, now = Date.now()) {

    if (!PHASES.includes(phase) || (mr != null && (typeof mr !== 'string' || mr.length > 300)) || (text != null && typeof text !== 'string')) {
        throw Object.assign(new Error(`expected a phase (${PHASES.join(', ')}), an optional MR (URL or !N) and text`), { status: 400 });
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
