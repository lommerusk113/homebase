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
    // a URL is cut to the MR itself (/diffs, #note_1, ?tab= follow it); one that names no MR would place no row
    const url = mr?.trim().startsWith('https://') ? mr.trim().match(/^https:\/\/[^\s?#]+?\/(?:-\/merge_requests|pull)\/\d+/)?.[0] : null;
    if (mr?.trim().startsWith('https://') && !url) {
        throw Object.assign(new Error('that URL names no MR: use the MR\'s URL or !N'), { status: 400 });
    }
    // an update without --mr keeps the MR the chat named before; a report that never named one would place no row
    const named = url || mr?.trim() || reports.get(sessionId)?.mr || null;
    if (phase !== 'done' && !named) {
        throw Object.assign(new Error('name the MR: --mr <url or !N>'), { status: 400 });
    }
    if (phase === 'done') {
        reports.delete(sessionId);
    } else {
        reports.set(sessionId, { phase, mr: named, text: text?.trim().slice(0, MAX) || null, at: now });
    }
    await save(dir);
}

// One write at a time, each of the map as it is then: two at once would share the temp file and leave a broken one
let saving = Promise.resolve();
const save = dir => (saving = saving.catch(() => {}).then(async () => {
    const keep = [...reports].slice(-MAX); // ponytail: the newest MAX chats only
    const file = join(dir, 'reports.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
    await rename(tmp, file);
}));

// When a report is over: a doing report at the chat's next prompt, a needs-you one also at an answer to its question.
// s: a session with lastPromptAt and lastAnswerAt.
export const endsAt = (s, r) => (r.phase === 'needs-you' ? s.lastAnswerAt ?? s.lastPromptAt : s.lastPromptAt) ?? 0;

// Forgets a chat's report (answered since, see sessions.mjs attachReports) and saves that, so a restart doesn't bring it back.
export function forgetReport(sessionId) {

    if (reports.delete(sessionId) && savedIn) {
        save(savedIn).catch(() => {});
    }
}
