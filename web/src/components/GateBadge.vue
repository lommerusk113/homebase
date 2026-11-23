<script setup lang="ts">
// review-gate badge: ✓ gate (ready), ⚠ gate (fix first), gate stale once the MR head moved.
import { computed, useId } from 'vue';
import { ago, plain } from 'old/core.js';

/** mr: the forge's word for it ("MR" or "PR") */
const props = defineProps<{ gate: Gate; mr: string }>();
const id = useId();
const look = computed(() => (props.gate.stale ? ['stale', 'gate stale'] : props.gate.verdict === 'ready' ? ['ready', '✓ gate'] : ['fix', '⚠ gate']));
const tip = computed(() => {
    const g = props.gate, when = g.at && ago(g.at);

    return [`review-gate: ${g.verdict}${g.stale ? ` (${props.mr} changed since)` : ''}`, when && (when === 'now' ? 'just now' : `${when} ago`), plain(g.tldr)].filter(Boolean).join(' · ');
});
</script>

<template>
    <span :id="id" :class="`gate-badge gate-${look[0]}`" :aria-label="tip">{{ look[1] }}</span>
    <wa-tooltip :for="id">{{ tip }}</wa-tooltip>
</template>
