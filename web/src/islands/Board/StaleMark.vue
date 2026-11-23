<script setup lang="ts">
// ⚠ beside an MR whose state couldn't be checked just now: what is shown is the last good answer.
import { useId } from 'vue';
import { forgeWords } from 'old/core.js';
import { ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const id = useId();
</script>

<template>
    <span :id="id" class="ci-pill stale" tabindex="0" aria-label="May be out of date">⚠</span>
    <wa-tooltip :for="id">Couldn't check this {{ forgeWords(item.pr).mr }} just now ({{ item.forgeError }}), so this is what it was last time</wa-tooltip>
</template>
