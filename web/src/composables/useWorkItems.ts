import { computed } from 'vue';
import { api, hooks, inView } from 'old/core.js';
import { renderBoard } from 'old/list.js';
import { oldState } from '@/old';
import { byStart } from '@/lib/board';
import { useNotice } from '@/composables/useNotice';
import { useSentMarks } from '@/composables/useSentMarks';

const gone = new Map<string, number>();

/** The board's work items (one per MR, plus agents without one): in view, in the picked milestone, newest work first. */
export function useWorkItems(marks = useSentMarks()) {

    // rows dismissed here: key -> the item's `updated` then. The server leaves them out too, but a poll answered just
    // before it knew would show the row once more. As there, a helper that moved since is back.
    const dismissedHere = (x: WorkItem) => x.agentStatus !== 'running' && (gone.get(x.key) ?? -1) >= x.updated;
    const items = computed(() => oldState.value.sessions.filter(inView).flatMap(s => s.items || [])
        .filter(x => hooks.inMilestone(x) && !dismissedHere(x)).map(x => marks.optimistic(x)).sort(byStart));
    const byKey = computed(() => new Map(items.value.map(x => [x.key, x])));
    const inColumn = (column: Column) => items.value.filter(x => x.column === column);

    // A row with no MR to act on, whose helper isn't working: the user can put it away.
    const canDismiss = (x: WorkItem) => !x.pr && x.agentStatus !== 'running' && !x.sent && !x.requested;
    /** Hides the row on every device (POST /api/dismissed) until its helper runs again. A failed one leaves it. */
    async function dismiss(x: WorkItem) {

        const r = await api(`/api/dismissed?key=${encodeURIComponent(x.key)}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to dismiss this row');

            return;
        }

        gone.set(x.key, x.updated);
        renderBoard();
    }

    /** Moves the row to another group on every device (POST /api/pins), held until its state changes; 'auto' drops the pin. */
    async function pin(x: WorkItem, column: Column | 'auto') {

        const r = await api(`/api/pins?key=${encodeURIComponent(x.key)}&column=${column}&fp=${encodeURIComponent(x.fp ?? '')}`, { method: 'POST' }).catch(() => null);
        if (!r?.ok) {
            useNotice().showError(r ? await r.text() : 'Couldn’t reach Homebase to move this row');

            return;
        }

        hooks.refresh();
    }

    // with a milestone picked every row is in it, so its tag would only repeat the header pill
    const tagsMilestone = () => !hooks.milestoneId();

    return { items, byKey, inColumn, canDismiss, dismiss, pin, tagsMilestone };
}
