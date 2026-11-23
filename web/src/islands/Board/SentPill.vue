<script setup lang="ts">
import { ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
</script>

<template>
    <span class="sent-pill" role="status"><span class="pulse" />{{ item.sent ? 'Sent to Claude…' : 'Claude is on it…' }}</span>
</template>
