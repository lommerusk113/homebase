<script setup lang="ts">
// "💬 2 new · Børre" in the accent colour, or a muted "💬 5" when none are new since last checked.
import { computed } from 'vue';
import { CommentsKey, ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { fresh, authors } = useInjected(CommentsKey);
const unseen = computed(() => fresh(item.value));
const count = computed(() => item.value.comments?.count ?? 0);
</script>

<template>
    <span :class="['cm-badge', unseen.length && 'new']" :aria-label="unseen.length ? `${unseen.length} new comments` : `${count} comments, none new`">{{ unseen.length ? `💬 ${unseen.length} new · ${authors(unseen)}` : `💬 ${count}` }}</span>
</template>
