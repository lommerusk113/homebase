<script setup lang="ts">
// The panel's top strip: repo and branches, totals, the MR link, refresh and close.
import { computed } from 'vue';
import { DiffKey, useInjected } from '@/keys';

const { head, totals, mr, load, close, backToList } = useInjected(DiffKey);
const compared = computed(() => (head.value?.base ? `${head.value.branch} compared with ${head.value.base.ref} at ${head.value.base.sha.slice(0, 8)}` : ''));
</script>

<template>
    <header class="dv-head">
        <button class="dv-btn dv-back" type="button" @click="backToList">← Files</button>
        <div class="dv-title" :title="compared">
            <template v-if="head">
                <b>{{ head.repo }}</b>{{ ' ' }}<span class="dv-branch mono">{{ head.branch || '(no branch)' }}</span>
                <template v-if="head.base">{{ ' → ' }}<span class="dv-branch mono">{{ head.base.ref }}</span></template>
            </template>
            <b v-else>Changes</b>
        </div>
        <span class="dv-totals">
            <template v-if="totals">{{ totals.files }} file{{ totals.files === 1 ? '' : 's' }}{{ ' ' }}<span class="dv-add">+{{ totals.add }}</span>{{ ' ' }}<span class="dv-del">−{{ totals.del }}</span></template>
        </span>
        <a class="dv-btn dv-mr" target="_blank" rel="noopener" :href="mr ?? undefined" :hidden="!mr">Open MR</a>
        <button class="dv-btn dv-refresh" type="button" title="Refresh (r)" @click="load">Refresh</button>
        <button class="dv-btn dv-close" type="button" title="Close (Esc)" aria-label="Close" @click="close">×</button>
    </header>
</template>
