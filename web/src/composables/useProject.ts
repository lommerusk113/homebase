import { computed, toRef } from 'vue';
import { $, hooks, isTracked, projectCounts, waitsOnYou } from 'old/core.js';
import { openNewProject } from 'old/newproject.js';
import { oldState } from '@/old';
import type { PickItem } from '@/composables/usePicker';

// One row of the project picker: a dot for the loudest state among its chats, and what they are doing underneath.
function pickItem(value: string, name: string, mine: Session[]): PickItem {

    const chats = mine.filter(s => !s.sidechain);
    const waiting = mine.flatMap(s => s.items || []).filter(x => x.column === 'needs-you').length + mine.filter(waitsOnYou).length; // as projectCounts
    const working = chats.filter(s => s.status === 'working').length;
    const parts = [waiting && `${waiting} waiting on you`, working && `${working} working`, chats.some(s => s.rulesStale) && 'old rules', `${chats.length || 'No'} chat${chats.length === 1 ? '' : 's'}`];

    return { value, name, sub: parts.filter(Boolean).join(' · '), state: waiting ? 'needs' : working ? 'working' : 'idle' };
}

/** The picked project ('all' or a tracked one), the picker's rows, and the old page's way to change it (picker, board, chat follow). */
export function useProject() {

    const project = toRef(() => oldState.value.project);
    const name = computed(() => (project.value === 'all' ? 'All my projects' : project.value));

    /** "All my projects", then the tracked ones A-Z. */
    const items = computed(() => {

        const { sessions, tracked } = oldState.value;
        const names = [...tracked].sort((a, b) => a.localeCompare(b));

        return [pickItem('all', 'All my projects', sessions.filter(isTracked)), ...names.map(n => pickItem(n, n, sessions.filter(s => s.project === n)))];
    });

    /** Chats and items waiting on you in the projects not shown: the picker button is the one cue for them. */
    const waitingElsewhere = computed(() => {

        const { sessions, tracked, project: picked } = oldState.value;

        return picked === 'all' ? 0 : projectCounts(sessions, tracked).filter(c => c.project !== picked).reduce((n, c) => n + c.waiting, 0);
    });

    return {
        project,
        name,
        items,
        waitingElsewhere,
        setProject: (to: string) => hooks.setProject(to),
        newProject: () => openNewProject(),
        // ponytail: the old dialog opens from its own header button, until the dialog is ported
        manageProjects: () => $('manage').click()
    };
}
