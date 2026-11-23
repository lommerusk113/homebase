<script setup lang="ts">
// The footer's rate limit strip, drawn into #limits itself (the Token saver switch sits beside it); hidden without a dump.
import { watchEffect } from 'vue';
import { $ } from 'old/core.js';
import { useLimits } from '@/composables/useLimits';
import LimitItem from './Limits/LimitItem.vue';

const { windows, updated, pace } = useLimits();

watchEffect(() => { $('limits').hidden = !windows.value.length; });
</script>

<template>
    <LimitItem v-for="(w, i) in windows" :key="w.label" :id="`limit-${i}`" :view="w" :updated="updated" />
    <span v-if="pace" class="limit-pace" style="color: var(--c-warn)">· empty in ~{{ pace }}m</span>
</template>
