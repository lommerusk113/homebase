<script setup lang="ts">
// A main chat whose turn never ended and went silent: under Needs you until the user opens it.
import { toRef } from 'vue';
import { touch } from 'old/core.js';
import { ChatRowsKey, useInjected } from '@/keys';
import ChatName from './ChatName.vue';
import StepInChat from './StepInChat.vue';

const props = defineProps<{ sid: string }>();
const { byId, openDied, quietFor } = useInjected(ChatRowsKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <tr class="asking died" :data-key="`died:${sid}`" role="button" @click="openDied(s)">
        <td class="what" colspan="6">
            <b><span class="pulse" />{{ ' ' }}<ChatName :sid="sid" what="stopped mid-turn" /></b>
            <small class="next">{{ `No activity for ${quietFor(s) === 'now' ? 'a moment' : quietFor(s)} — Claude may be stuck or closed${touch() ? '' : ' · click to look'}` }}</small>
            <StepInChat :sid="sid" />
        </td>
    </tr>
</template>
