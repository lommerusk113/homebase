// Open GitLab MRs by others that ask the signed-in user for a review: read-only GETs, one list call per GitLab host Homebase knows.
import { api, isGitLab, whoAmI, swrEntry, refetch, prState, pipelineOf } from './forge.mjs';
import { repoPaths } from './account.mjs';

export const REVIEWS_TTL_MS = 120_000;

// The list API's MRs as the rows the Work tab draws: not mine, newest update first.
export function reviewRows(list, me, pipelines = new Map()) {

    return list.filter(m => m.author?.username !== me && m.state === 'opened')
        .map(m => ({
            url: m.web_url,
            iid: m.iid,
            title: m.title,
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
