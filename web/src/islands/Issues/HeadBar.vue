<script setup lang="ts">
// The milestone's issues as one bar with its legend: closed, can be closed, in progress, not started, unassigned.
import { computed } from 'vue';
import { IssuesKey, useInjected } from '@/keys';

const { ms, groups } = useInjected(IssuesKey);

const segments = computed(() => {

    const g = groups.value;
    const all: [number, string, string][] = [[ms.value?.closed ?? 0, '--c-ready', 'closed'], [g.closable.length, '--c-ready', 'can be closed'],
        [g.doing.length, '--c-doing', 'in progress'], [g.assigned.length, '--c-idle', 'not started'], [g.unassigned.length, '--c-needs', 'unassigned']];

    return all.filter(([n]) => n);
});
</script>

<template>
    <div>
        <div class="is-bar">
            <i v-for="[n, colour, label] in segments" :key="label" :style="{ flex: n, background: `var(${colour})` }" />
        </div>
        <div class="is-legend">
            <span v-for="[n, colour, label] in segments" :key="label" :style="{ '--c': `var(${colour})` }"><i class="sw" />{{ n }} {{ label }}</span>
        </div>
    </div>
</template>
