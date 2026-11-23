<script setup lang="ts">
// The chat icon on a row backed by its own chat: that chat in the pane, with its composer.
import { ChatRowsKey, useInjected } from '@/keys';
import ChatIcon from '@/components/ChatIcon.vue';

defineProps<{ sid: string }>();
const { focus } = useInjected(ChatRowsKey);
</script>

<template>
    <ChatIcon @click="focus(sid)" />
</template>
