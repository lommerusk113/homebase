<script setup lang="ts">
// The row's one-click command (label and message from the server's rowAction), with the message as its tooltip.
// keys.js's a key finds it by .act-btn and clicks it from script.
import { useId } from 'vue';
import { ItemKey, SentMarksKey, useInjected } from '@/keys';
import { bindChat } from 'old/chat.js';
import { alreadySent } from '@/composables/useSend';

const item = useInjected(ItemKey);
const { press } = useInjected(SentMarksKey);
const id = useId();
const openReviewer = (reviewerId: string) => bindChat(reviewerId);
</script>

<template>
    <wa-button :id="id" class="act-btn" size="s" appearance="outlined" :disabled="item.action?.kind === 'reviewing' || undefined" @click.stop="press(item, $event.isTrusted)">{{ alreadySent.has(item.key) ? 'Sent to Claude' : item.action?.label }}</wa-button>
    <wa-tooltip :for="id">{{ item.action?.hint ?? item.action?.message }}</wa-tooltip>
    <wa-button v-if="item.action?.reviewerId" class="open-reviewer" size="s" appearance="plain" aria-label="Open reviewer" title="Open reviewer" @click.stop="openReviewer(item.action.reviewerId)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg></wa-button>
</template>
