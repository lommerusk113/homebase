import { computed, ref, watch, type Ref } from 'vue';

/** A row of a picker; state colours its dot: needs, working or idle. */
export interface PickItem { value: string; name: string; sub?: string; state?: string }

const SEARCH_FROM = 8; // the filter field shows from this many rows; with fewer it appears once something is typed

/**
 * A filterable list of choices behind a button (combobox + listbox): open or closed, the filter text and the
 * highlighted row. Focus stays in the filter field while it is open; the rows are never focused themselves.
 * id prefixes the rows' ids; onPick runs with the chosen value after the list closed.
 */
export function usePicker(id: string, items: Ref<PickItem[]>, value: Ref<string>, onPick: (value: string) => void) {

    const isOpen = ref(false);
    const query = ref('');
    const active = ref('');
    const revealed = ref(0); // counts the times the highlighted row must be scrolled into view
    const refocused = ref(0); // counts the times focus must go back to the button

    const shown = computed(() => {

        const q = query.value.trim().toLowerCase();

        return items.value.filter(it => !q || it.name.toLowerCase().includes(q));
    });
    const few = computed(() => items.value.length < SEARCH_FROM);
    const current = computed(() => items.value.find(it => it.value === value.value));
    const rowId = (of: string) => {

        const i = items.value.findIndex(it => it.value === of);

        return i < 0 ? '' : `${id}-${i}`;
    };

    function setActive(to: string, scroll = true) {

        active.value = to;
        if (scroll) {
            revealed.value++;
        }
    }

    // the highlight stays on a shown row: typing, or a poll that drops its row, moves it to the first one
    watch(shown, list => {
        if (isOpen.value && !list.some(it => it.value === active.value)) {
            setActive(list[0]?.value ?? '');
        }
    });

    function open() {

        if (isOpen.value) {
            return;
        }
        query.value = '';
        isOpen.value = true;
        setActive(value.value);
    }

    /** refocus: back to the button (not when focus already moved on). */
    function close(refocus: boolean) {

        if (!isOpen.value) {
            return;
        }
        isOpen.value = false;
        if (refocus) {
            refocused.value++;
        }
    }

    function pick(chosen: string) {

        close(true);
        onPick(chosen);
    }

    /** A key pressed in the open list; true when the picker used it. */
    function key(name: string): boolean {

        if (name === 'Escape') {
            close(true);
            return true;
        }
        if (name === 'Enter') {
            if (items.value.some(it => it.value === active.value)) {
                pick(active.value);
            }
            return true;
        }

        const vis = shown.value, at = vis.findIndex(it => it.value === active.value);
        const to = ({ ArrowDown: (at + 1) % vis.length, ArrowUp: (at <= 0 ? vis.length : at) - 1, Home: 0, End: vis.length - 1 } as Record<string, number>)[name];
        // Home and End move the caret while there is filter text
        if (to == null || !vis.length || ((name === 'Home' || name === 'End') && query.value)) {
            return false;
        }
        setActive(vis[to].value);

        return true;
    }

    return {
        listId: `${id}-list`, items, value, current, isOpen, query, active, shown, few, revealed, refocused,
        rowId, setActive, open, close, toggle: () => (isOpen.value ? close(true) : open()), pick, key
    };
}
