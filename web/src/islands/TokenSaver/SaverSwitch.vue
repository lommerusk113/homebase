<script setup lang="ts">
import { TokenSaverKey, useInjected } from '@/keys';

const { on, note, set } = useInjected(TokenSaverKey);
</script>

<template>
    <wa-switch
        id="saver-switch"
        size="s"
        title="On: helpers that chats start run on Sonnet. A chat already running picks it up with 'Load new rules'."
        :checked.prop="on"
        @change="set(($event.target as HTMLInputElement).checked)"
    >Token saver</wa-switch>
    <small v-if="note" id="saver-note">{{ note }}</small>
</template>
