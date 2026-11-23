<script setup lang="ts">
// The row's title, after its project on the all-projects board and its milestone when none is picked.
import { ItemKey, ProjectKey, WorkItemsKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { project } = useInjected(ProjectKey);
const { tagsMilestone } = useInjected(WorkItemsKey);
</script>

<template>
    <b :title="item.firstTitle ? `Started as: ${item.firstTitle}` : undefined"><template v-if="project === 'all'"><span class="s-proj">{{ item.project }}</span>{{ ' ' }}</template><span v-if="item.milestone && tagsMilestone()" class="chip ms-tag" :title="`Milestone: ${item.milestone.title}`">⚑ {{ item.milestone.title }}</span>{{ item.title }}<template v-if="item.manual">{{ ' ' }}<span class="chip" title="Manual mode: you drive this chat, no helpers">manual</span></template>{{ ' ' }}<span v-if="item.checks" class="chip" :title="`Check commands, last run ${new Date(item.checks.at).toLocaleTimeString()}`">checks {{ { pass: '✓', fail: '✗', running: '…' }[item.checks.state] }}</span></b>
</template>
