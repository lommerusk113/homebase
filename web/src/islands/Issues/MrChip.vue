<script setup lang="ts">
// An issue's MR or PR as a chip, with its pipeline next to it: ✓ passed, ✗ failed, ● running or pending, grey for the rest.
// ponytail: list.js has the same chip and pill as DOM builders (prChip, ciPill); one shared component once the board's rows are ported.
import { computed } from 'vue';
import { ago, prLabel } from 'old/core.js';
import { uid } from '@/lib/uid';

const props = defineProps<{ mr: IssueMr }>();

const PIPE: Record<string, [string, string]> = {
    success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'],
    preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled']
};

const id = uid('is-ci');
const pipe = computed(() => {

    const p = props.mr.pipeline;
    if (!p?.status) {
        return null;
    }
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const when = p.at && ago(Date.parse(p.at));

    return { ...p, icon, label: `Pipeline ${word}`, tip: `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}` };
});
</script>

<template>
    <a class="chip mono" :href="mr.url" target="_blank" @click.stop>{{ prLabel(mr.url) }}</a>
    <template v-if="pipe">
        <a v-if="pipe.url" :id class="ci-pill" :class="`ci-${pipe.status}`" :href="pipe.url" target="_blank" :aria-label="pipe.label" @click.stop>{{ pipe.icon }}</a>
        <span v-else :id class="ci-pill" :class="`ci-${pipe.status}`" :aria-label="pipe.label">{{ pipe.icon }}</span>
        <wa-tooltip :for="id">{{ pipe.tip }}</wa-tooltip>
    </template>
</template>
