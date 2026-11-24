import { computed, effectScope, ref, shallowRef, toRef, watch } from 'vue';
import { api, hooks, state, store } from 'old/core.js';
import { emptyPill, inMilestone, isLoading, toData } from '@/lib/milestone';
import { renderBoard } from 'old/list.js';
import { oldState } from '@/old';

const FETCH_MS = 30_000; // the server caches the forge calls; this only bounds how stale the pill gets
const POLL_MS = 3000;
const HOLD_MS = 5000; // how long the board waits for the stored milestone's issues before showing every row
const LOADING_MS = 1000; // while the server is still loading the issues, or refreshing stale ones

// One per page: the Header island's pill and the Issues island are separate apps that show the same answer.
/** The picked project's /api/milestones answer: null for "All my projects", undefined until its first answer is in. */
const data = shallowRef<Milestones | null>();
/** The menu entry being switched to, until its answer is in: the old data stays, dimmed. */
const busy = ref<string | null>(null);
/** The milestone the board is filtered by, with the project it belongs to: never applied to another project's rows. */
let picked: { project: string, id: number, title: string, issues: Set<number> | null, hold?: boolean } | null = null;
let stop = new AbortController();
let fetchNow = () => {};
let started = false;

// Right after a project switch the board renders before follow() has run, so picked is still the old project's: answer
// from the stored choice, held, the same way poll() will.
const pickedHere = () => {
    if (picked?.project === state.project) {
        return picked;
    }
    const stored = state.project === 'all' ? 0 : Number(store.get(`milestone:${state.project}`));

    return stored > 0 ? { project: state.project, id: stored, title: '', issues: null, hold: true } : null;
};
hooks.inMilestone = x => inMilestone(x, pickedHere());
hooks.milestoneHolding = () => !!pickedHere()?.hold;
hooks.milestoneId = () => pickedHere()?.id ?? null;

// Polls /api/milestones for one project until signal aborts, which also cancels a fetch in flight: an answer for
// another project, or after the abort, is dropped. The chosen milestone is kept per project (localStorage).
function poll(project: string, signal: AbortSignal) {

    const key = `milestone:${project}`;
    let json = ''; // the last answer shown
    let at = 0; // when the last successful fetch finished
    let asked: string | null = null; // the milestone that fetch was for
    let pending = false;
    let loading = false;

    // A stored milestone id holds the rows of other milestones back until its issues are in (never past HOLD_MS).
    const stored = Number(store.get(key));
    if (stored > 0) {
        picked = { project, id: stored, title: '', issues: null, hold: true };
        const give = setTimeout(() => {
            if (picked?.hold && picked.project === project) {
                picked.hold = false;
                renderBoard();
            }
        }, HOLD_MS);
        signal.addEventListener('abort', () => clearTimeout(give));
    }

    async function tick() {

        const want = store.get(key) ?? '';
        if (signal.aborted || pending || (want === asked && Date.now() - at < (loading ? LOADING_MS : FETCH_MS))) {
            return;
        }

        pending = true;
        let ok = false;
        try {
            const r = await api(`/api/milestones?project=${encodeURIComponent(project)}&milestone=${encodeURIComponent(want)}`, { signal });
            const body = toData(r.status, await r.text(), project);
            if (signal.aborted || body.project !== project) {
                return;
            }
            ok = true;
            if (busy.value === want) {
                busy.value = null;
            }
            const text = JSON.stringify(body);
            if (text !== json) { // only a changed answer redraws, so an open menu stays put
                json = text;
                loading = isLoading(body);
                data.value = body;
                // "Assigned to me" is no milestone for the board; issues: the numbers of its issues, once loaded
                const ms = body.selected, g = ms?.groups;
                picked = ms && typeof ms.id === 'number' ? { project, id: ms.id, title: ms.title, issues: g ? new Set(Object.values(g).flat().map(i => i.iid)) : null, hold: !g && !!picked?.hold } : null;
                renderBoard();
            }
        } catch {} finally {
            at = ok ? Date.now() : 0; // a failed call retries on the next tick
            asked = want;
            pending = false;
        }

        if (loading) {
            setTimeout(tick, LOADING_MS);
        } else if (want !== (store.get(key) ?? '')) {
            tick(); // picked again while this call ran
        }
    }

    // the refresh button: fetch now instead of waiting out FETCH_MS
    fetchNow = () => {
        at = 0;
        tick();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('homebase:refresh', fetchNow, { signal });
    signal.addEventListener('abort', () => clearInterval(timer));
    tick();
}

// The old project's poll stops the moment the project changes; "All my projects" has no milestones.
function follow(project: string) {

    stop.abort();
    stop = new AbortController();
    fetchNow = () => {};
    busy.value = null;
    data.value = project === 'all' ? null : undefined;
    if (project !== 'all') {
        poll(project, stop.signal);
    }
}

/**
 * The milestone filter of the picked project: the forge's milestones and the chosen one's issues (polled), and the
 * choice, which also filters the board's work items. Read-only towards GitLab/GitHub.
 */
export function useMilestoneFilter() {

    if (!started) {
        started = true;
        // detached: the poll lives as long as the page, whichever island asked first
        effectScope(true).run(() => watch(toRef(() => oldState.value.project), follow, { immediate: true }));
    }

    /** to: a milestone id, 'mine' (assigned to me, all milestones) or 'none'. */
    function choose(to: string) {

        store.set(`milestone:${state.project}`, to);
        busy.value = to;
        fetchNow();
    }

    /** The chosen milestone, or "Assigned to me"; null for none. */
    const ms = computed(() => data.value?.selected ?? null);
    /** The milestone list is not in yet (a slow forge). */
    const listLoading = computed(() => !data.value || data.value.loading);
    /** What to say when the project has no milestones to show; null when it has. */
    const empty = computed(() => (data.value ? emptyPill(data.value) : null));

    return { data, busy, ms, listLoading, empty, choose };
}
