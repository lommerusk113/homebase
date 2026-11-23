<script setup lang="ts">
// The stage bar, and under it the tokens and working time of the item's agents (the breakdown in a tooltip).
import { computed, useId } from 'vue';
import { ItemKey, useInjected } from '@/keys';
import StageBar from './StageBar.vue';

const item = useInjected(ItemKey);
const id = useId();
const meta = computed(() => [item.value.tokens, item.value.time].filter(Boolean).join(' · '));
</script>

<template>
    <td class="prog">
        <StageBar />
        <template v-if="meta">
            <small :id="id" class="meta">{{ meta }}</small>
            <wa-tooltip v-if="item.tokensTitle" :for="id">{{ item.tokensTitle }}</wa-tooltip>
        </template>
    </td>
</template>
