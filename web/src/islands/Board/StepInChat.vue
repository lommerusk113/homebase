<script setup lang="ts">
// "Step in" on a row backed by its own chat: that chat in the pane, with its composer.
import { ChatRowsKey, useInjected } from '@/keys';

defineProps<{ sid: string }>();
const { focus } = useInjected(ChatRowsKey);
</script>

<template>
    <wa-button class="step-in" size="s" appearance="outlined" @click.stop="focus(sid)">Step in</wa-button>
</template>
