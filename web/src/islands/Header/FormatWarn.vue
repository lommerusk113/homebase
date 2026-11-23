<script setup lang="ts">
import { FormatWarnKey, useInjected } from '@/keys';

const { text } = useInjected(FormatWarnKey);
</script>

<template>
    <span id="format-warn" class="fmtwarn" :hidden="!text">{{ text }}</span>
</template>
