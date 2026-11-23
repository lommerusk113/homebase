<script setup lang="ts">
// One window: its name, a bar of what is left, and the figure; the details (and when the dump was taken) in a tooltip.
import { limitView } from 'old/core.js';

defineProps<{ id: string; view: ReturnType<typeof limitView>; updated: string }>();
const color = (left: number) => (left >= 50 ? 'var(--c-ready)' : left >= 10 ? 'var(--c-warn)' : 'var(--c-danger)');
</script>

<template>
    <span class="limit" :id="id"><span class="limit-label">{{ view.label }}</span><i><b :style="{ width: `${view.left}%`, background: color(view.left) }"></b></i><span>{{ view.text }}</span></span>
    <wa-tooltip :for="id">{{ view.tip }}<template v-if="updated"><br>{{ updated }}</template></wa-tooltip>
</template>
