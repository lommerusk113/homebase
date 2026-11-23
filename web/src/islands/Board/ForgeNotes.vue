<script setup lang="ts">
import { ForgeNotesKey, useInjected } from '@/keys';

const { notes } = useInjected(ForgeNotesKey);
</script>

<template>
    <div v-for="n in notes" :key="n.text" :class="['forge-note', n.err && 'err']" role="status">{{ n.text }}</div>
</template>
