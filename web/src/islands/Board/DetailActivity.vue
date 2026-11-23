<script setup lang="ts">
// The agents that worked on the item before its newest one.
import { plain } from '@/lib/text';
import { ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
</script>

<template>
    <h4>Earlier agents · {{ item.activity.length }}</h4>
    <ul class="activity">
        <li v-for="a in item.activity" :key="a.id"><wa-badge variant="neutral" appearance="filled" pill>{{ a.status }}</wa-badge>{{ ' ' }}<b>{{ a.description }}</b>{{ a.tldr ? ` — ${plain(a.tldr)}` : '' }}</li>
    </ul>
</template>
