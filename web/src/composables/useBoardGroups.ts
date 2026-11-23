import { computed, toRef } from 'vue';
import { COLUMNS, inView } from 'old/core.js';
import { forgeWords } from '@/lib/forge';
import { reviewNote } from '@/lib/board';
import { oldState } from '@/old';
import type { useWorkItems } from '@/composables/useWorkItems';
import type { useChatRows } from '@/composables/useChatRows';
import type { useReviews } from '@/composables/useReviews';
import type { useFolds } from '@/composables/useFolds';

/** The board's groups, top to bottom: one per column that has rows, and "Review requested" after Needs you. */
export function useBoardGroups(work: ReturnType<typeof useWorkItems>,
                               chats: ReturnType<typeof useChatRows>,
                               reviews: ReturnType<typeof useReviews>,
                               folds: ReturnType<typeof useFolds>) {

    const hasProjects = toRef(() => oldState.value.tracked.length > 0);
    // the chats' own rows a column also holds
    const extra = (column: Column) => (column === 'doing' ? chats.starting.value.length + chats.working.value.length
        : column === 'needs-you' ? chats.asking.value.length + chats.died.value.length : 0);

    const groups = computed(() => {
        const out: { key: Column | 'reviews'; fold: boolean }[] = COLUMNS.filter(c => work.inColumn(c.key).length || extra(c.key))
            .map(c => ({ key: c.key, fold: folds.folds(c.key) }));
        if (reviews.reviews.value.length) { // after Needs you, else first
            out.splice(out.findIndex(g => g.key === 'needs-you') + 1, 0, { key: 'reviews', fold: false });
        }

        return out;
    });
    // nothing open to look at: said in words, as the welcome when the board is empty
    const empty = computed(() => {
        if (groups.value.some(g => !g.fold || g.key === 'review')) {
            return null;
        }
        const mr = forgeWords(oldState.value.sessions.filter(inView).find(s => s.forge)?.forge?.name).mr;

        return { cls: groups.value.length ? 'd-empty' : 'welcome', text: `No ${mr}s or subagents right now` };
    });
    // the Needs you group's own count
    const needsCount = computed(() => work.inColumn('needs-you').length + extra('needs-you'));
    const note = (column: Column) => (column === 'review' ? reviewNote(work.inColumn(column)) : '');

    return { hasProjects, groups, empty, extra, needsCount, note };
}
