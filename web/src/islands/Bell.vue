<script setup lang="ts">
// The header's notifications bell: the off icon is a bell with a slash, on adds an accent dot (styles.css #bell).
import { useTemplateRef } from 'vue';
import { useBell } from '@/composables/useBell';

const { supported, on, blocked, toggle } = useBell();
const tip = useTemplateRef<HTMLElement & { open: boolean }>('tip');

async function click() {

    if (await toggle() && tip.value) {
        tip.value.open = true;
    }
}
</script>

<template>
    <button class="quiet" id="bell" :class="{ on }" :hidden="!supported" title="Desktop notifications" aria-label="Desktop notifications" :aria-pressed="on" @click="click">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <g class="b-on"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><circle class="b-dot" cx="18.5" cy="5.5" r="3.5"/></g>
            <g class="b-off"><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/></g>
        </svg>
    </button>
    <wa-tooltip v-if="blocked" ref="tip" for="bell">Blocked in browser settings</wa-tooltip>
</template>
