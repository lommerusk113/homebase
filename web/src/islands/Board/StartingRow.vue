<script setup lang="ts">
// "#2225 · starting…": the main chat took the issue on, but no subagent or MR shows it yet. Click chats with that session.
import { toRef } from 'vue';
import { ChatRowsKey, useInjected } from '@/keys';
import StepInChat from './StepInChat.vue';

const props = defineProps<{ sid: string; issue: string }>();
const { byId, focus, viewing } = useInjected(ChatRowsKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <tr class="starting" :class="{ viewing: viewing(sid) }" :data-key="`starting:${sid}:${issue}`" @click="focus(sid)">
        <td class="what" colspan="6">
            <b><span class="pulse" />{{ ` #${issue} · starting…` }}</b>
            <small class="next">{{ s.status === 'working' && s.now?.includes(`#${issue}`) ? 'The chat session is on it' : 'Queued in the chat session' }}</small>
            <StepInChat :sid="sid" />
        </td>
    </tr>
</template>
