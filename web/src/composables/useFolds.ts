import { store } from 'old/core.js';
import { oldState } from '@/old';

/**
 * Which folded groups are open. Merged and Closed stay open for this page load once opened, together; Recently
 * finished and In review remember per project, after a toggle. In review is open until it grows past a few rows.
 */
export function useFolds() {

    const key = (column: Column) => `fold:${column}:${oldState.value.project}`;
    const folds = (column: Column) => ['review', 'finished', 'done', 'closed'].includes(column);

    function isOpen(column: Column, rows: number): boolean {

        if (column === 'done' || column === 'closed') {
            return !!oldState.value.showMerged;
        }
        const chosen = store.get(key(column));

        return chosen ? chosen === 'open' : column === 'review' && rows <= 3;
    }

    function setOpen(column: Column, open: boolean) {

        if (column === 'done' || column === 'closed') { // ponytail: the two folds open and close together
            oldState.value.showMerged = open;
        } else {
            store.set(key(column), open ? 'open' : 'closed');
        }
    }

    return { folds, isOpen, setOpen };
}
