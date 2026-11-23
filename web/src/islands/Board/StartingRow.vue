<script setup lang="ts">
// "#2225 · starting…": the main chat took the issue on, but no subagent or MR shows it yet. Click chats with that session.
import { toRef } from 'vue';
import { ChatRowsKey, useInjected } from '@/keys';

const props = defineProps<{ sid: string; issue: string }>();
const { byId, bind } = useInjected(ChatRowsKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <tr class="starting" :data-key="`starting:${sid}:${issue}`" @click="bind(sid)">
        <td class="what" colspan="6">
            <b><span class="pulse" />{{ ` #${issue} · starting…` }}</b>
            <small class="next">{{ s.status === 'working' && s.now?.includes(`#${issue}`) ? 'The chat session is on it' : 'Queued in the chat session' }}</small>
        </td>
    </tr>
</template>
