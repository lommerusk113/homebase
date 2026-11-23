<script setup lang="ts">
// The changed files, under "Uncommitted" and "Committed on this branch".
import { DiffKey, useInjected } from '@/keys';
import DiffFile from './DiffFile.vue';

const { groups, truncated } = useInjected(DiffKey);
</script>

<template>
    <nav class="dv-files" aria-label="Changed files">
        <template v-for="g in groups" :key="g.group">
            <h4 class="dv-group">{{ g.label }} · {{ g.files.length }}</h4>
            <DiffFile v-for="f in g.files" :key="f.path" :group="g.group" :file="f" />
        </template>
        <div v-if="truncated" class="dv-note">Too many files: the list is cut short.</div>
    </nav>
</template>
