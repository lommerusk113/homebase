<script setup lang="ts">
// The folded "Closed · 12" line: the milestone's closed issues per person, and each as a chip once unfolded.
import { computed, useTemplateRef } from 'vue';
import { firstName } from 'old/core.js';
import { closedBy } from 'old/issues.js';
import { IssuesKey, useInjected } from '@/keys';

const { groups, closedOpen } = useInjected(IssuesKey);
const line = useTemplateRef('line');

const by = computed(() => closedBy(groups.value.done).map(([who, n]) => `${who === 'unassigned' ? who : firstName(who)} ${n}`).join(' · '));
</script>

<template>
    <details ref="line" class="is-closed" :open="closedOpen" @toggle="closedOpen = line?.open ?? false">
        <summary><b>Closed · {{ groups.done.length }}</b><span>{{ by }}</span></summary>
        <div class="chips">
            <a v-for="i in groups.done" :key="i.iid" class="chip" :href="i.url" :title="i.title" target="_blank" rel="noopener">#{{ i.iid }} {{ i.title }}</a>
        </div>
    </details>
</template>
