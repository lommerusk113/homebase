// What chats report about their work with `homebase status` (POST /api/status): session id -> { phase, mr: URL, text, at }.
// Structured, so a row's group never depends on how an agent words its reply. In reports.json in the Homebase dir.
// sessions.mjs attachReports says when one counts and ends it; items.mjs links a chat to the MR whose URL it names.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const reports = new Map();
export const PHASES = ['doing', 'needs-you', 'done'];
const MAX = 200;

// A stored report's MR is a URL (report() resolves --mr once): anything else would never match a row.
const valid = r => !!r && PHASES.includes(r.phase) && (r.mr == null || (typeof r.mr === 'string' && r.mr.length <= 300))
    && (r.text == null || typeof r.text === 'string');

// --mr as the MR's URL, by the chat's forge ({ gitlab, web: 'https://host/group/repo' }, null when unknown): a URL cut to the MR
// itself (/diffs, #note_1, ?tab= follow it), !N on GitLab, #N on GitHub. Anything else throws 400 naming what it takes.
export function resolveMr(mr, forge) {

    const t = mr.trim();
    const url = t.match(/^https:\/\/[^\s?#]+?\/(?:-\/merge_requests|pull)\/\d+/)?.[0];
    if (url) {
        return url;
    }
    const n = t.match(/^([!#])(\d+)$/);
    if (n && forge && (n[1] === '!') === forge.gitlab) {
        return `${forge.web}${forge.gitlab ? '/-/merge_requests/' : '/pull/'}${n[2]}`;
    }
    const takes = !forge ? "the MR's URL" : forge.gitlab ? "!N or the MR's URL (on GitLab #N is an issue)" : "'#N' (quoted) or the PR's URL";

    throw Object.assign(new Error(`--mr takes ${takes}`), { status: 400 });
}

let savedIn = null; // the Homebase dir loadReports read, where forgetReport writes

export function loadReports(dir) {

    savedIn = dir;
    reports.clear();
    try {
        for (const [id, r] of Object.entries(JSON.parse(readFileSync(join(dir, 'reports.json'), 'utf8')))) {
            if (valid(r) && (r.mr == null || r.mr.startsWith('https://')) && Number.isFinite(r.at)) { // as report() checks it: a hand-edited entry never takes the board down
                reports.set(id, r);
            }
        }
    } catch {} // missing or broken: no reports, chats report again
}

// phase done forgets the chat's report; any other replaces it. An update without --mr keeps the MR stored before; a needs-you
// report without any MR is the chat's own row. Throws 400 for an unknown phase, an over-long field or an --mr resolveMr refuses.
export async function report(dir, sessionId, { phase, mr = null, text = null } = {}, now = Date.now(), forge = null) {

    if (!valid({ phase, mr, text })) {
        throw Object.assign(new Error(`expected a phase (${PHASES.join(', ')}), an optional --mr and text`), { status: 400 });
    }
    if (phase === 'done') {
        reports.delete(sessionId);
    } else {
        const url = mr?.trim() ? resolveMr(mr, forge) : reports.get(sessionId)?.mr ?? null;
        reports.set(sessionId, { phase, mr: url, text: text?.trim().slice(0, MAX) || null, at: now });
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

// Forgets a chat's report (answered since, see sessions.mjs attachReports) and saves that, so a restart doesn't bring it back.
export function forgetReport(sessionId) {

    if (reports.delete(sessionId) && savedIn) {
        save(savedIn).catch(() => {});
    }
}
