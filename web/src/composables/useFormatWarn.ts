import { computed } from 'vue';
import { oldState } from '@/old';

/** The header warning when Claude Code's transcript or screen no longer parses (core.js setFormatWarn). */
export function useFormatWarn() {

    const text = computed(() => (oldState.value.formatWarn ? 'Claude Code\'s format changed — status may be wrong' : ''));

    return { text };
}
