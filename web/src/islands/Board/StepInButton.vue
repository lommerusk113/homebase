<script setup lang="ts">
// "Step in": opens the row's helper as its own conversation in the chat pane (its chat's question, when that is the one asking).
import { ItemKey, useInjected } from '@/keys';
import { useStepIn } from '@/composables/useStepIn';
import NeedsYou from './NeedsYou.vue';

const item = useInjected(ItemKey);
const { canStepIn, relayed, stepIn } = useStepIn();
</script>

<template>
    <template v-if="canStepIn(item)">
        <NeedsYou v-if="relayed(item)" />
        <wa-button class="step-in" size="s" appearance="outlined" @click.stop="stepIn(item)">Step in</wa-button>
    </template>
</template>
