import { computed } from 'vue';
import { oldState } from '@/old';

/**
 * The header warning when Claude Code's transcript or screen no longer parses (core.js setFormatWarn). version is the
 * server's own "Claude Code is newer than the checked version" message, '' when it has none: that alone shows it too.
 */
export function useFormatWarn(version: string) {

    const text = computed(() => [oldState.value.formatWarn ? 'Claude Code\'s format changed — status may be wrong' : '', version].filter(Boolean).join(' · '));

    return { text };
}
