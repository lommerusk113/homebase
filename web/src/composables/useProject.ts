import { toRef } from 'vue';
import { hooks } from 'old/core.js';
import { oldState } from '@/old';

/** The picked project ('all' or a tracked one), and the old page's way to change it (picker, board, chat follow). */
export function useProject() {

    const project = toRef(() => oldState.value.project);

    return { project, setProject: (name: string) => hooks.setProject(name) };
}
