<script setup lang="ts">
// The files the item's agent edited: the folder muted, the name bold.
import { ItemKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const cut = (f: string) => f.lastIndexOf('/') + 1;
</script>

<template>
    <h4>Files edited · {{ item.files.length }}</h4>
    <ul class="files">
        <li v-for="f in item.files" :key="f" :title="f">{{ f.slice(0, cut(f)) }}<b>{{ f.slice(cut(f)) }}</b></li>
    </ul>
</template>
