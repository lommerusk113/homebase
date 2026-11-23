<script setup lang="ts">
import { ConnectionKey, useInjected } from '@/keys';

const { offline, label } = useInjected(ConnectionKey);
</script>

<template>
    <span id="offline" class="offline" :hidden="!offline">{{ label }}</span>
</template>
