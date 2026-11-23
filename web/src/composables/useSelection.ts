import { toRef } from 'vue';
import { select } from 'old/list.js';
import { oldState } from '@/old';

/** The work row whose detail is open, and the old page's way to open or close one (which binds the chat to its session). */
export function useSelection() {

    const selected = toRef(() => oldState.value.selected as string | null);

    return { selected, toggle: (x: WorkItem) => select(x) };
}
