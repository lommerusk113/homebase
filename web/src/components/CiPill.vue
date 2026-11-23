<script setup lang="ts">
// CI pill: ✓ passed, ✗ failed, ● running/pending, grey for the rest; nothing without a pipeline. A link when the pipeline has a page.
import { computed, useId } from 'vue';
import { pipeWords } from '@/lib/board';

const props = defineProps<{ pipeline: Pipeline | null | undefined; narrow?: boolean }>();
const id = useId();
const words = computed(() => pipeWords(props.pipeline));
</script>

<template>
    <template v-if="pipeline && words">
        <component :is="pipeline.url ? 'a' : 'span'" :id="id" :class="['ci-pill', `ci-${pipeline.status}`, narrow && 'ci-narrow']"
                   :href="pipeline.url" :target="pipeline.url ? '_blank' : undefined" :aria-label="words.label"
                   @click="pipeline.url && $event.stopPropagation()">{{ words.icon }}</component>
        <wa-tooltip :for="id">{{ words.tip }}</wa-tooltip>
    </template>
</template>
