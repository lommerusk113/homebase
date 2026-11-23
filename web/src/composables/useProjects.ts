import { computed, ref } from 'vue';
import { checkProject, hooks, saveTracked, state } from 'old/core.js';
import { renderBoard } from 'old/list.js';
import { openLog } from 'old/log.js';
import { oldState } from '@/old';
import { openNewProject } from './useNewProject';

const shown = ref(false);

/** Opens the "Projects on your board" dialog. */
export const showProjects = () => { shown.value = true; };

/** The projects dialog: those on the board, and those only seen in recent sessions, to add. */
export function useProjects() {

    const counts = computed(() => {

        const c: Record<string, number> = {};
        for (const s of oldState.value.sessions) {
            c[s.project] = (c[s.project] || 0) + 1;
        }

        return c;
    });
    const onBoard = computed(() => [...oldState.value.tracked].sort());
    const others = computed(() => Object.keys(counts.value).filter(p => !oldState.value.tracked.includes(p)).sort((a, b) => counts.value[b] - counts.value[a]));

    function track(name: string, on: boolean) {

        state.tracked = on ? [...state.tracked, name] : state.tracked.filter(p => p !== name);
        saveTracked();
        checkProject();
        renderBoard();
    }

    /** Closes the dialog, then does what a button there opens. */
    const leave = (then: () => void) => () => {
        shown.value = false;
        then();
    };

    return {
        shown,
        counts,
        onBoard,
        others,
        // a paired device (data-remote from the server) cannot pair others: the server answers 403 there
        canPair: !('remote' in document.documentElement.dataset),
        track,
        newProject: leave(() => openNewProject()),
        openFolder: leave(() => openNewProject('open')),
        pair: leave(() => hooks.openPairing?.()),
        log: leave(openLog)
    };
}
