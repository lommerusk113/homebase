<script setup lang="ts">
// The Changes view, a panel over the board card (the chat and its composer stay beside it): the changed files left, the
// picked file's unified diff right; on a phone the list first, then the diff with a back button. public/diff.js mounts it
// per opening and unmounts it on close.
import { onMounted, provide, useTemplateRef } from 'vue';
import { useEventListener } from '@vueuse/core';
import { plainKeysOff } from 'old/core.js';
import { DiffKey } from '@/keys';
import { useDiff } from '@/composables/useDiff';
import DiffHead from './Diff/DiffHead.vue';
import DiffFiles from './Diff/DiffFiles.vue';
import DiffPane from './Diff/DiffPane.vue';

const props = defineProps<{ sid: string; item: string | null }>();
const diff = useDiff(props.sid, props.item);
const { one, empty, loading } = diff;
const panel = useTemplateRef<HTMLElement>('panel');
const STEPS: Record<string, 1 | -1> = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 };

provide(DiffKey, diff);

// while the panel is up its keys are its own: the board's shortcuts (keys.js) never see them; typing in the chat is left alone
useEventListener(window, 'keydown', (e: KeyboardEvent) => {
    if ((e.target as Element).closest?.('input, textarea, select, [contenteditable], wa-input, wa-textarea')) {
        return;
    }
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.altKey || plainKeysOff(e)) {
        return;
    }
    if (e.key === 'Escape') {
        diff.close();
    } else if (e.key === 'r') {
        diff.load();
    } else if (STEPS[e.key]) {
        diff.step(STEPS[e.key]);
    } else {
        return;
    }
    e.preventDefault();
}, true);

onMounted(() => {
    panel.value?.focus();
    diff.load();
});
</script>

<template>
    <div ref="panel" class="dv" :class="{ one, empty, loading }" role="region" aria-label="Changes" tabindex="-1">
        <DiffHead />
        <div class="dv-body">
            <DiffFiles />
            <DiffPane />
        </div>
    </div>
</template>
