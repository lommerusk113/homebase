<script setup lang="ts">
// The chat icon, in the row's action column, on a row backed by its own chat: that chat in the pane, with its composer.
import { ChatRowsKey, useInjected } from '@/keys';
import ChatIcon from '@/components/ChatIcon.vue';

defineProps<{ sid: string }>();
const { focus } = useInjected(ChatRowsKey);
</script>

<template>
    <td class="act">
        <ChatIcon @click="focus(sid)" />
    </td>
</template>
