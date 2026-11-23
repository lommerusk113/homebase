<script setup lang="ts">
// The project's main chat while it works: "<request>" with "project · Now: <step> · for 2m". Click chats with it. Leaves with the status.
import { toRef } from 'vue';
import { ChatRowsKey, useInjected } from '@/keys';
import StepInChat from './StepInChat.vue';

const props = defineProps<{ sid: string }>();
const { byId, focus, viewing, workingTitle, workingLine } = useInjected(ChatRowsKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <tr class="starting working" :class="{ viewing: viewing(sid) }" :data-key="`working:${sid}`" role="button" @click="focus(sid)">
        <td class="what" colspan="5">
            <b><span class="pulse" />{{ ' ' }}<bdi>{{ s.title || workingTitle(s) }}</bdi>{{ ' ' }}<span class="chip">main chat</span><template v-if="s.manual">{{ ' ' }}<span class="chip" title="Manual mode: you drive this chat, no helpers">manual</span></template></b>
            <small class="next">{{ workingLine(s) }}</small>
        </td>
        <StepInChat :sid="sid" />
    </tr>
</template>
