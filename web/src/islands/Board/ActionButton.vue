<script setup lang="ts">
// The row's one-click command (label and message from the server's rowAction), with the message as its tooltip.
// keys.js's a key finds it by .act-btn and clicks it from script.
import { useId } from 'vue';
import { ItemKey, SentMarksKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { press } = useInjected(SentMarksKey);
const id = useId();
</script>

<template>
    <wa-button :id="id" class="act-btn" size="s" appearance="outlined" @click.stop="press(item, $event.isTrusted)">{{ item.action?.label }}</wa-button>
    <wa-tooltip :for="id">{{ item.action?.message }}</wa-tooltip>
</template>
