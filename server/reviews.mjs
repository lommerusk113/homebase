// Open GitLab MRs by others that ask the signed-in user for a review: read-only GETs, one list call per GitLab host Homebase knows.
import { api, isGitLab, whoAmI, swrEntry, refetch, prState, pipelineOf } from './forge.mjs';
import { repoPaths, keepAside } from './account.mjs';
import { verdictOf } from './summaries.mjs';
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const REVIEWS_TTL_MS = 120_000;

// The list API's MRs as the rows the Work tab draws: not mine, newest update first.
export function reviewRows(list, me, pipelines = new Map()) {

    return list.filter(m => m.author?.username !== me && m.state === 'opened')
        .map(m => ({
            url: m.web_url,
            iid: m.iid,
            title: m.title,
            sha: m.sha ?? null,
            project: m.references?.full?.replace(/!\d+$/, '') ?? m.web_url.replace(/^https:\/\/[^/]+\//, '').replace(/\/-\/merge_requests\/\d+.*/, ''),
            author: m.author?.name ?? m.author?.username ?? '',
            draft: !!m.draft,
            updatedAt: Date.parse(m.updated_at) || 0,
            pipeline: pipelines.get(m.web_url) ?? (m.head_pipeline ? pipelineOf(m.head_pipeline) : null)
        }))
        .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

async function fetchReviews(repo) {

    const me = await whoAmI(repo);
    const list = await api(repo, `merge_requests?reviewer_username=${encodeURIComponent(me.username)}&state=opened&scope=all&per_page=100`);
    // the pipeline is not in the list payload: the cached single-MR lookup has it
    const states = await Promise.all(list.map(async m => [m.web_url, (await prState(m.web_url).catch(() => null))?.pipeline]));

    return reviewRows(list, me.username, new Map(states));
}

const warned = new Set();

const entries = () => {
    const hosts = new Map([...repoPaths.values()].filter(isGitLab).map(r => [r.host, r]));

    return [...hosts].map(([host, repo]) => [host, swrEntry(`reviews:${host}`, REVIEWS_TTL_MS, () => fetchReviews(repo))]);
};

// The listed MR by url. A miss waits for a fresh list first: the board keeps showing the last list it got, so after a
// restart or a failed refresh the server's cache can be colder than the row the user clicked.
export async function reviewRequest(url) {

    const find = () => reviewRequests().find(x => x.url === url);

    return find() ?? (await Promise.all(entries().map(([, hit]) => hit.pending ?? refetch(hit, hit.fn))), find());
}

// The cached rows; never waits, so the first call after start is empty. A failed refresh keeps serving the last good
// rows and logs once per outage per host; the board's forge state (forge.mjs forgeStatus) reads the entry's error.
export function reviewRequests() {

    return entries().flatMap(([host, hit]) => {
        if (!hit.error) {
            warned.delete(host);
        } else if (!warned.has(host)) {
            warned.add(host);
            console.error(`reviews: ${host}: ${hit.error.message.split('\n')[0]}`);
        }

        return hit.value ?? [];
    });
}

// Findings of a finished review chat: the Send findings / Approve button of a row, and "Findings sent" after it.
// reviews-sent.json in the Homebase dir: MR url -> { sha, at } of the head whose findings went to GitLab.
const sentFindings = new Map();
const same = (a, b) => !!a && !!b && (a.startsWith(b) || b.startsWith(a));

export function loadReviewsSent(dir) {

    sentFindings.clear();
    try {
        for (const [url, v] of Object.entries(JSON.parse(readFileSync(join(dir, 'reviews-sent.json'), 'utf8')))) {
            sentFindings.set(url, { sha: v.sha ?? null, at: Number(v.at) || 0 });
        }
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'reviews-sent.json'), e.message, 'review rows forget which findings were sent');
        }
    }
}

export async function markReviewSent(dir, url, sha, now = Date.now()) {

    sentFindings.set(url, { sha: typeof sha === 'string' ? sha : null, at: now });
    const file = join(dir, 'reviews-sent.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(Object.fromEntries([...sentFindings].slice(-200))), { mode: 0o600 });
    await rename(tmp, file);
}

/** The review chat's tmux name for a row (see startReview in start.mjs). */
export const reviewTmux = r => `cc-new-${r.project.split('/').pop()}-review-${r.iid}`.replace(/[^A-Za-z0-9._-]/g, '-');

// Fixed prompts: nothing from GitLab goes into them but the MR's own ref.
const ref = r => `MR !${r.iid} of ${r.project} (${r.url})`;
export const FINDINGS_PROMPT = r => `Post your review findings on ${ref(r)} to GitLab as review comments, as one batch: GitLab draft notes (glab api projects/:id/merge_requests/${r.iid}/draft_notes, then bulk_publish), each finding that applies to a line as an inline discussion with a position (file and line of the diff), the rest in one summary note. Post only what you listed. Do not approve or request changes unless your verdict says so. Then say what you posted.`;
export const APPROVE_PROMPT = r => `Your review found nothing to fix on ${ref(r)}. Approve it (glab mr approve ${r.iid}), after posting any minor remarks you listed as one summary note. Then say what you did.`;

/**
 * What the row offers once its review chat (`session`, or undefined) is done, `rec` being what was sent for the MR:
 * { kind: 'sent' } for the current head, { kind: 'send' | 'approve', message, sessionId } for a finished review
 * not sent yet ('approve' when its verdict is ready), else null. A reply that was sent for an older head is not offered again.
 */
export function reviewFindings(r, session, rec) {

    if (rec && same(rec.sha, r.sha)) {
        return { kind: 'sent' };
    }
    if (!session || session.status === 'working' || session.asking || !session.lastReply || (rec && (session.lastReplyAt ?? 0) <= rec.at)) {
        return null;
    }
    const approve = verdictOf(session.lastReply) === 'ready'; // ponytail: no verdict named -> send, a summary note is never wrong

    return { kind: approve ? 'approve' : 'send', message: (approve ? APPROVE_PROMPT : FINDINGS_PROMPT)(r), sessionId: session.id };
}

/** The review rows with their `findings` against the live sessions. */
export const reviewsWithFindings = (sessions, rows = reviewRequests()) =>
    rows.map(r => ({ ...r, findings: reviewFindings(r, sessions.find(s => s.tmux === reviewTmux(r)), sentFindings.get(r.url)) }));
