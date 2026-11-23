<script setup lang="ts">
// Lifecycle Implement → Verify → Review → Approved → Merged; the current segment pulses while an agent runs.
import { COL, LIFECYCLE } from 'old/core.js';
import { ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const segment = (x: WorkItem, i: number) => (i < x.stage ? 'on' : i === x.stage ? (x.agentStatus === 'running' || x.sent || x.requested ? 'on now' : 'on') : '');
</script>

<template>
    <div class="stage" :style="{ '--c': `var(${COL[item.column].color})` }">
        <div class="bar"><i v-for="(name, i) in LIFECYCLE" :key="name" :class="segment(item, i)" :title="name" /></div>
        <small>{{ item.stageLabel }}</small>
    </div>
</template>
