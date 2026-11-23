<script setup lang="ts">
// The MR's human comments: the new ones first counted, the seen ones too, muted (the row's badge counts them).
import { computed } from 'vue';
import { ago } from 'old/core.js';
import { CommentsKey, ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { freshInDetail, every, markAllSeen } = useInjected(CommentsKey);
const unseen = computed(() => freshInDetail(item.value));
const all = computed(() => every(item.value));
</script>

<template>
    <h4>{{ unseen.length ? `New comments · ${unseen.length}` : `Comments · ${item.comments?.count} · none new` }}<button class="show mark-all" @click="markAllSeen">Mark all seen</button></h4>
    <ul v-if="all.length" class="comments">
        <li v-for="c in all" :key="c.id" :class="{ seen: !unseen.includes(c) }"><b>{{ c.author }}</b><span class="muted">{{ ` · ${ago(Date.parse(c.at))}${c.resolved === false ? ' · unresolved' : ''} · ` }}</span><a :href="c.url" target="_blank">{{ c.excerpt || '(no text)' }}</a></li>
    </ul>
</template>
