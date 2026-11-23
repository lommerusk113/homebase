<script setup lang="ts">
// A chat row's cells after the title, the same as a work row's: no stage bar or usage (a chat has none), no MR or
// branch, the chat icon in the action column (that chat in the pane, with its composer), and how long ago it was active.
import { toRef } from 'vue';
import { ago } from '@/lib/time';
import { ChatRowsKey, useInjected } from '@/keys';
import ChatIcon from '@/components/ChatIcon.vue';

const props = defineProps<{ sid: string }>();
const { byId, focus } = useInjected(ChatRowsKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <td class="prog" />
    <td class="pr" />
    <td class="br" />
    <td class="act">
        <ChatIcon @click="focus(sid)" />
    </td>
    <td class="when">{{ ago(s.lastActivity ?? s.updated) }}</td>
</template>
