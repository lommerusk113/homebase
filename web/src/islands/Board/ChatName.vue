<script setup lang="ts">
// A chat row's title as one element: "<project> · <chat title> <what>", the project only on the all-projects board.
// Text from a chat goes in its own <bdi>, so a right-to-left one doesn't reorder the labels around it.
import { toRef } from 'vue';
import { ChatRowsKey, ProjectKey, useInjected } from '@/keys';

const props = defineProps<{ sid: string; what: string }>();
const { byId, title } = useInjected(ChatRowsKey);
const { project } = useInjected(ProjectKey);
const s = toRef(() => byId.value.get(props.sid)!);
</script>

<template>
    <span><template v-if="project === 'all'"><bdi>{{ s.project }}</bdi>{{ ' · ' }}</template><bdi>{{ title(s) }}</bdi>{{ ` ${what}` }}</span>
</template>
