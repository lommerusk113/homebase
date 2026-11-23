<script setup lang="ts">
// A group's dot in its column's colour; Doing's pulses.
import { COL } from 'old/core.js';

defineProps<{ column: Column }>();
</script>

<template>
    <span :class="['dot', column === 'doing' && 'live']" :style="{ '--c': `var(${COL[column].color})` }" />
</template>
