<script setup lang="ts">
// The line above the first item when older ones are not shown: hidden by Clear view, not loaded yet, or further
// back than the server reads.
import { FeedKey, useInjected } from '@/keys';

const { view, showHidden, showEarlier } = useInjected(FeedKey);
</script>

<template>
    <div v-if="view.head === 'hidden'" class="c-hidden">Earlier messages hidden · <button class="show" @click="showHidden">Show</button></div>
    <div v-else-if="view.head === 'earlier'" class="c-hidden c-earlier">Earlier messages not shown · <button class="show" @click="showEarlier">Show earlier</button></div>
    <div v-else-if="view.head === 'capped'" class="c-hidden c-capped">Older messages are not shown here — the terminal has the whole chat</div>
</template>
