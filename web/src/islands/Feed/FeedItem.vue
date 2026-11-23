<script setup lang="ts">
// One row of the feed. An item that can't be drawn shows as its plain text; the rest of the feed stays.
import { onErrorCaptured, ref, watch } from 'vue';
import type { FeedRow } from '@/composables/useFeed';
import Bubble from './Bubble.vue';
import CommandLine from './CommandLine.vue';
import ToolsLine from './ToolsLine.vue';

const props = defineProps<{ row: FeedRow }>();
const broken = ref(false);

onErrorCaptured(e => {
    console.error(e);
    broken.value = true;
    return false;
});
watch(() => props.row, () => { broken.value = false; }); // a new drawing gets a new try
</script>

<template>
    <div v-if="row.kind === 'new'" class="tools compact c-new">New</div>
    <CommandLine v-else-if="row.kind === 'commands'" :run="row.run" />
    <div v-else-if="broken" :class="`bubble ${row.item.role}`">{{ typeof row.item.text === 'string' ? row.item.text : JSON.stringify(row.item.text ?? '') }}</div>
    <ToolsLine v-else-if="row.kind === 'line'" :row="row" />
    <Bubble v-else :row="row" />
</template>
