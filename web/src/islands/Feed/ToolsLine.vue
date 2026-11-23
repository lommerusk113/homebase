<script setup lang="ts">
// A line that is no message: what Claude's tools did (quiet ones hidden as noise, a risky command always shown, a
// finished agent's result folded under its line), an API error, or a compact divider.
import { computed } from 'vue';
import { FeedKey, useInjected } from '@/keys';
import type { LineRow } from '@/composables/useFeed';
import FoldText from '@/components/FoldText.vue';
import RiskyLine from './RiskyLine.vue';

const props = defineProps<{ row: LineRow }>();
const { view } = useInjected(FeedKey);
const item = computed(() => props.row.item);
const key = computed(() => `${view.value.sid}:${item.value.at}`);
</script>

<template>
    <div v-if="item.role === 'error'" class="tools api-error">{{ item.text }}</div>
    <div v-else-if="item.role === 'compact'" class="tools compact">{{ item.text }}</div>
    <div v-else :class="['tools', { quiet: item.quiet, risky: item.risky, detail: item.detail }]">
        <RiskyLine v-if="item.risky" :text="item.text" :fold-key="`${key}:ran`" />
        <template v-else-if="!item.detail">{{ item.text }}</template>
        <FoldText v-if="item.detail" :tldr="item.text" :rest="item.detail" :fold-key="`${key}:detail`" />
    </div>
</template>
