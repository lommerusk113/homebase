import { computed, ref, shallowRef } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { PR_HREF } from '@/lib/forge';
import { closeDiff } from 'old/diff.js';
import { oldState } from '@/old';
import { addedRows, diffTotals, parseDiff } from '@/lib/diff';
import { getDiff, setChatCount } from './useDiffCounts';

const GROUPS = [['uncommitted', 'Uncommitted'], ['committed', 'Committed on this branch']] as const;

export type DiffGroup = typeof GROUPS[number][0];
/** One file of the list: the same path can be in both groups. */
export interface DiffPick { group: DiffGroup; path: string }

const same = (a: DiffPick | null, b: DiffPick) => a?.group === b.group && a.path === b.path;
const note = (text: string) => ({ note: text });

/**
 * One open Changes panel, read-only: what a chat (item null) or a work item's worktree changed in its git folder
 * (GET /api/diff, server/diff.mjs), the picked file and its diff.
 */
export function useDiff(sid: string, item: string | null) {

    const phone = useMediaQuery('(max-width: 900px)');
    const view = shallowRef<DiffView | null>(null);
    const sel = shallowRef<DiffPick | null>(null);
    const pane = shallowRef<{ note: string } | { rows: DiffRow[] }>(note('Loading…'));
    const loading = ref(false);
    const failed = ref(false); // the list could not be read: the head keeps what it showed
    const one = ref(false); // a phone shows the list or one file's diff
    const bodies = new Map<string, DiffBody>();

    const head = computed(() => (view.value?.repo ? view.value : null));
    const totals = computed(() => (head.value ? diffTotals(head.value) : null));
    const groups = computed(() => (failed.value || !head.value ? [] : GROUPS
        .map(([group, label]) => ({ group, label, files: head.value?.[group] ?? [] }))
        .filter(g => g.files.length)));
    const all = computed(() => groups.value.flatMap(g => g.files.map((f): DiffPick => ({ group: g.group, path: f.path }))));
    const empty = computed(() => failed.value || (view.value != null && !all.value.length));
    const truncated = computed(() => !failed.value && Boolean(head.value?.truncated));

    // The MR of what is shown: the row's own, else the MR of this chat's item on the same branch. Only an https MR/PR link.
    const mr = computed(() => {
        const items = oldState.value.sessions.flatMap(s => s.items ?? []);
        const url = item != null
            ? items.find(i => i.key === item)?.pr
            : items.find(i => i.pr && i.sessionId === sid && i.branch && i.branch === head.value?.branch)?.pr;

        return head.value && url && PR_HREF.test(url) ? url : null;
    });

    async function pick(p: DiffPick) {

        const key = `${p.group}\0${p.path}`;
        sel.value = p;
        one.value = true;

        if (!bodies.has(key)) {
            pane.value = note('Loading…');
            try {
                bodies.set(key, await getDiff<DiffBody>(sid, item, { group: p.group, file: p.path }));
            } catch (e) {
                const why = (e as Error).message;
                if (sel.value === p) {
                    pane.value = note(why === 'unknown file' ? 'This file is no longer in the list. Refresh to see the current changes.' : `Couldn't load the diff: ${why}`);
                }
                return;
            }
        }
        const body = bodies.get(key);
        if (sel.value !== p || !body) { // another file picked meanwhile
            return;
        }

        const rows = body.diff != null ? parseDiff(body.diff) : body.text != null ? addedRows(body.text) : [];
        pane.value = body.binary ? note('Binary file: no text diff.')
            : body.tooLarge ? note('Diff too large to show here.')
            : !rows.length ? note('No text changes (empty file, or only its mode changed).')
            : { rows };
    }

    async function load() {

        loading.value = true;
        let v: DiffView;
        try {
            v = await getDiff(sid, item);
        } catch (e) {
            failed.value = true;
            pane.value = note(`Couldn't read the changes: ${(e as Error).message}`);
            return;
        } finally {
            loading.value = false;
        }

        view.value = v;
        failed.value = false;
        bodies.clear();
        if (item == null) {
            setChatCount(sid, v);
        }

        if (!all.value.length) {
            one.value = false;
            pane.value = note(!v.repo ? 'No git repository here: the folder is gone or is not inside one.'
                : v.base ? `No changes: nothing uncommitted, and nothing committed on ${v.branch} since ${v.base.ref}.`
                : 'No changes: nothing uncommitted.');
            return;
        }

        // keep the picked file over a refresh; a desktop starts on the first one, a phone on the list
        const keep = all.value.find(p => same(sel.value, p)) ?? (phone.value ? null : all.value[0]);
        if (!keep) {
            sel.value = null;
            one.value = false;
            pane.value = note('Pick a file to see its diff.');
            return;
        }
        await pick(keep);
    }

    /** The file below (1) or above (-1) the picked one, clamped; with none picked, the first or the last. */
    function step(by: 1 | -1) {

        const files = all.value, i = files.findIndex(p => same(sel.value, p));
        const next = files[i < 0 ? (by > 0 ? 0 : files.length - 1) : Math.max(0, Math.min(files.length - 1, i + by))];
        if (next) {
            pick(next);
        }
    }

    return {
        head, totals, mr, groups, truncated, sel, pane, loading, empty, one,
        isPicked: (p: DiffPick) => same(sel.value, p),
        load, pick, step,
        backToList: () => { one.value = false; },
        close: () => closeDiff()
    };
}
