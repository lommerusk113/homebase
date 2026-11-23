<script setup lang="ts">
// "!12" or "#12", a link to the MR or PR. "open" is the usual case, so only merged/closed are spelled out.
import { prLabel } from '@/lib/forge';

defineProps<{ pr: string; state?: string }>();
</script>

<template>
    <a class="chip mono" :href="pr" target="_blank" @click.stop>{{ prLabel(pr) }}{{ state && state !== 'open' ? ` · ${state}` : '' }}</a>
</template>
