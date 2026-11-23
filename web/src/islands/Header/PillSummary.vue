<script setup lang="ts">
// The pill itself: the chosen milestone, its open count, due date and progress; a spinner while anything loads.
import { computed } from 'vue';
import { pillLabel } from 'old/milestone.js';
import { MilestoneFilterKey, useInjected } from '@/keys';

const { data, busy, ms, listLoading, empty } = useInjected(MilestoneFilterKey);

const label = computed(() => (ms.value ? pillLabel(ms.value) : null));
const title = computed(() => (listLoading.value ? 'Loading milestones…' : empty.value?.tip ?? label.value?.tip ?? 'Show only work items of a milestone'));
// the due date, short ("1 Dec"); amber once it has passed
const dueAt = computed(() => (ms.value?.due && !ms.value.mine ? new Date(`${ms.value.due}T23:59:59`) : null));
const done = computed(() => (ms.value?.total ? Math.round(100 * ms.value.closed / ms.value.total) : 0));
</script>

<template>
    <summary :title>
        <template v-if="listLoading"><span>⚑</span><span class="ld">Loading…</span><wa-spinner /></template>
        <template v-else-if="empty"><span>⚑</span><span>{{ empty.text }}</span></template>
        <template v-else>
            <span>{{ ms?.mine ? '@' : '⚑' }}</span><span class="t">{{ ms ? ms.title : 'No milestone' }}</span>
            <template v-if="ms">
                <span class="n">· {{ label?.text }}</span>
                <span v-if="dueAt" class="d" :class="{ late: dueAt.getTime() < Date.now() }">· {{ dueAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) }}</span>
                <!-- the progress bar once the issue groups are in -->
                <span v-if="ms.groups" class="ms-bar"><b :style="{ width: `${done}%` }" /></span>
            </template>
            <wa-spinner v-if="ms?.loading || data?.updating" />
        </template>
        <!-- the milestone being switched to: the old data stays, dimmed, until the new one's is in -->
        <wa-spinner v-if="busy != null" class="picked" />
    </summary>
</template>
