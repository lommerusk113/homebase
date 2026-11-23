<script setup lang="ts">
// The chat's corner "±" (Changes) button with the number of changed files; public/diff.js mounts it in the chat's top strip.
import { useChatDiffCount } from '@/composables/useDiffCounts';

const { sid, n, open } = useChatDiffCount();
</script>

<template>
    <button id="c-diff" class="c-diff" type="button" title="What this chat changed (d)" aria-label="Changes" :hidden="!sid" @click="open">
        <span class="c-diff-icon">±</span><span class="c-diff-n" :hidden="!n">{{ n }}</span>
    </button>
</template>
