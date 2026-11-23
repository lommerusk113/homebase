<script setup lang="ts">
// A not-started card's button: Start opens a new chat in its own worktree with the prompt typed in, unsent; "Check on it" shows the chat that already has it.
import { computed } from 'vue';
import { IssuesKey, useInjected } from '@/keys';
import type { Card } from '@/composables/useIssues';

const props = defineProps<{ card: Card }>();

const { starting, workOn, showWork, start, takenBy, manual, setManual } = useInjected(IssuesKey);

const work = computed(() => workOn(props.card));
const going = computed(() => starting(props.card));
// somebody else's issue: Start is off and the tooltip says whose it is
const taken = computed(() => takenBy(props.card));
</script>

<template>
    <wa-button v-if="work" class="act-btn" size="s" variant="neutral" appearance="outlined" @click.stop="showWork(work)">Check on it</wa-button>
    <template v-else>
        <label class="manual-toggle" title="Manual: the new chat works step by step with you and starts no helpers" @click.stop><input type="checkbox" :checked="manual" @change="setManual(($event.target as HTMLInputElement).checked)">Manual</label>
        <wa-button class="act-btn" size="s" variant="brand" appearance="filled" :disabled.attr="going || !!taken || undefined" :title="taken" @click.stop="start(card)">{{ going ? 'Starting…' : 'Start' }}</wa-button>
    </template>
</template>
