<script setup lang="ts">
// A work row's "Changes" icon, only while the row's own worktree has changes; it opens the Changes view on that worktree.
// <component :is>, so Vue takes wa-button for the custom element it is; .attr, as waButton() in public/core.js sets them.
import { useRowDiffCount } from '@/composables/useDiffCounts';

const props = defineProps<{ item: WorkItem }>();
const { n, open } = useRowDiffCount(() => props.item);
</script>

<template>
    <component :is="'wa-button'" v-if="n" class="act-btn dv-row" :size.attr="'s'" :appearance.attr="'plain'" aria-label="Changes" :title.attr="'Changes'" @click.stop="open">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 6.5v7M8.5 10h7M8.5 17h7" /></svg>
    </component>
</template>
