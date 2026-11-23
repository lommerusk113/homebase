<script setup lang="ts">
// The Issues tab: the selected milestone's open issues in one lane per person (you first, then A–Z, then Unassigned).
import { computed, onBeforeUpdate, onMounted, onUpdated, provide, useTemplateRef } from 'vue';
import { hooks } from 'old/core.js';
import { emptyText } from 'old/issues.js';
import { IssuesKey } from '@/keys';
import { useIssues } from '@/composables/useIssues';
import IssuesHead from './Issues/IssuesHead.vue';
import IssuesSkeleton from './Issues/IssuesSkeleton.vue';
import IssueLane from './Issues/IssueLane.vue';
import ClosedLine from './Issues/ClosedLine.vue';

const issues = useIssues();
provide(IssuesKey, issues);
const { data, busy, ms, loading, lanes, words } = issues;
const pane = useTemplateRef('pane');

// null: "All my projects"; a selected milestone without groups failed to load its issues
const nothing = computed(() => (data.value === null ? 'Pick a project in the header to see its milestone issues.'
    : ms.value?.error ? `Could not load the issues: ${ms.value.error}` : 'Pick a milestone in the header pill to see its issues.'));

// keys.js keeps its roving tabindex and focus on the cards: tell it after every redraw
let hadFocus = false;
onBeforeUpdate(() => { hadFocus = !!pane.value?.contains(document.activeElement); });
onUpdated(() => hooks.rendered?.(hadFocus));
onMounted(() => hooks.rendered?.(false));
</script>

<template>
    <!-- stale: a picked milestone is still loading, so the old one's issues are dimmed -->
    <div ref="pane" class="is-pane" :class="{ stale: busy != null }" :aria-busy="loading || undefined">
        <template v-if="loading">
            <IssuesHead v-if="ms" hint="Loading issues…" />
            <IssuesSkeleton />
        </template>
        <div v-else-if="data?.reason" class="welcome">
            {{ emptyText(data) }}<template v-if="data.url">{{ ' ' }}<a :href="data.url" target="_blank" rel="noopener">Milestones page ↗</a></template>
        </div>
        <div v-else-if="!ms?.groups" class="welcome">{{ nothing }}</div>
        <template v-else>
            <IssuesHead :hint="data?.updating ? 'Updating…' : undefined" />
            <IssueLane v-for="(lane, n) in lanes" :key="lane.who?.username ?? ''" :lane :n />
            <ClosedLine />
            <div class="is-note">Read-only: Homebase never writes to {{ words.forge }}. "Send to chat" only types into the chat on the right.</div>
        </template>
    </div>
</template>
