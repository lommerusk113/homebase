<script setup lang="ts">
// The chosen milestone in numbers: its due date (a link to it), the issue counts, and the issues that can be closed.
import { computed } from 'vue';
import { forgeWords } from 'old/core.js';
import { due } from 'old/milestone.js';
import { MilestoneFilterKey, useInjected } from '@/keys';

const { ms } = useInjected(MilestoneFilterKey);

const counts = computed(() => {

    const g = ms.value?.groups;
    const all: [number, string][] = g ? [[g.doing.length, 'in progress'], [g.assigned.length, 'assigned'], [g.unassigned.length, 'unassigned']] : [];

    return all.filter(([n]) => n);
});
const closable = computed(() => ms.value?.groups?.closable ?? []);
const why = (i: Issue) => [i.title, 'Merged, issue still open', ...i.mrs.map(m => `${forgeWords(m.url).ref}${m.iid} ${m.state}`)].join('\n');
</script>

<template>
    <div v-if="ms" class="info">
        <a :href="ms.url" target="_blank" rel="noopener">{{ ms.mine ? 'Issues ↗' : due(ms.due) }}</a><span v-for="[n, label] in counts" :key="label">{{ n }} {{ label }}</span>
    </div>
    <template v-if="closable.length">
        <h5 class="hot">Can be closed ({{ closable.length }})</h5>
        <div class="chips">
            <a v-for="i in closable" :key="i.iid" class="chip" :href="i.url" :title="why(i)" target="_blank" rel="noopener">#{{ i.iid }} {{ i.title }}</a>
        </div>
    </template>
    <hr>
</template>
