<script setup lang="ts">
// Merge when ready / Unqueue: the row's second button, for Homebase's merge queue (server/queue.mjs).
import { ItemKey, SentMarksKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { pressQueue } = useInjected(SentMarksKey);
</script>

<template>
    <wa-button class="queue-btn" size="s" appearance="outlined" :title="item.queue?.message" @click.stop="pressQueue(item)">{{ item.queue?.label }}</wa-button>
</template>
