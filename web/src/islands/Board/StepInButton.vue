<script setup lang="ts">
// The chat icon: opens the row's helper (or, with no helper, its chat) as its own conversation in the chat pane (its chat's question, when that is the one asking).
import { ItemKey, useInjected } from '@/keys';
import { useStepIn } from '@/composables/useStepIn';
import ChatIcon from '@/components/ChatIcon.vue';
import NeedsYou from './NeedsYou.vue';

const item = useInjected(ItemKey);
const { canStepIn, relayed, asking, stepIn } = useStepIn();
</script>

<template>
    <template v-if="canStepIn(item)">
        <NeedsYou v-if="relayed(item) || asking(item)" />
        <ChatIcon @click="stepIn(item)" />
    </template>
</template>
