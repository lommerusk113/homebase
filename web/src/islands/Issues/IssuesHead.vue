<script setup lang="ts">
// The tab's heading: the milestone, how many issues are open, and when it is due.
// hint: "Loading issues…" or "Updating…" next to the title, with a spinner.
import { computed } from 'vue';
import { IssuesKey, useInjected } from '@/keys';
import HeadBar from './HeadBar.vue';

defineProps<{ hint?: string }>();

const { ms, words } = useInjected(IssuesKey);

const due = computed(() => (ms.value?.due ? new Date(`${ms.value.due}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null));
</script>

<template>
    <div v-if="ms" class="is-head">
        <div class="is-title">
            <b>⚑ {{ ms.title }}</b><a :href="ms.url" target="_blank" rel="noopener">{{ words.forge }} ↗</a><span v-if="hint" class="is-hint"><wa-spinner />{{ hint }}</span>
        </div>
        <div class="is-big">{{ `${(ms.total ?? 0) - ms.closed} open ` }}<small>of {{ ms.total ?? '…' }}</small></div>
        <HeadBar />
        <div class="is-due">
            <template v-if="ms.mine">across <b>all milestones</b></template>
            <template v-else-if="due">due <b>{{ due }}</b></template>
            <b v-else>No due date</b>
        </div>
    </div>
</template>
