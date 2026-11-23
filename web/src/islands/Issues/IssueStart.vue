<script setup lang="ts">
// A not-started card's button: Start types "Implement #N" into the chat; "Check on it" shows the chat that already has it.
import { computed } from 'vue';
import { firstName } from 'old/core.js';
import { IssuesKey, useInjected } from '@/keys';
import type { Card } from '@/composables/useIssues';

const props = defineProps<{ card: Card }>();

const { data, canSend, starting, workOn, showWork, send } = useInjected(IssuesKey);

const work = computed(() => workOn(props.card));
const going = computed(() => starting(props.card));
// somebody else's issue: say so before it is started
const assigned = computed(() => {

    const { assignees } = props.card;

    return assignees.length && !assignees.some(p => p.username === data.value?.me?.username) ? `Assigned to ${assignees.map(p => firstName(p.name)).join(', ')}` : undefined;
});
</script>

<template>
    <wa-button v-if="work" class="act-btn" size="s" variant="neutral" appearance="outlined" @click.stop="showWork(work)">Check on it</wa-button>
    <wa-button v-else class="act-btn" size="s" variant="brand" appearance="filled" :disabled.attr="going || !canSend || undefined" :title="assigned" @click.stop="send(card)">{{ going ? 'Starting…' : 'Start' }}</wa-button>
</template>
