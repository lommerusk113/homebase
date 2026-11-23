<script setup lang="ts">
// The row's one-click command (label and message from the server's rowAction), with the message as its tooltip.
// keys.js's a key finds it by .act-btn and clicks it from script.
import { useId } from 'vue';
import { ItemKey, SentMarksKey, useInjected } from '@/keys';
import { bindChat } from 'old/chat.js';

const item = useInjected(ItemKey);
const { press } = useInjected(SentMarksKey);
const id = useId();
const openReviewer = (reviewerId: string) => bindChat(reviewerId);
</script>

<template>
    <wa-button :id="id" class="act-btn" size="s" appearance="outlined" :disabled="item.action?.kind === 'reviewing' || undefined" @click.stop="press(item, $event.isTrusted)">{{ item.action?.label }}</wa-button>
    <wa-tooltip :for="id">{{ item.action?.hint ?? item.action?.message }}</wa-tooltip>
    <wa-button v-if="item.action?.reviewerId" class="open-reviewer" size="s" appearance="plain" @click.stop="openReviewer(item.action.reviewerId)">Open reviewer</wa-button>
</template>
