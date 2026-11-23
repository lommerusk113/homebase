<script setup lang="ts">
// A titled list of projects, each with its session count and a button: Remove for those on the board, + Add for the rest.
import { ProjectsKey, useInjected } from '@/keys';

defineProps<{ title: string; names: string[]; kind: 'add' | 'rm'; none: string }>();
const { counts, track } = useInjected(ProjectsKey);
</script>

<template>
    <h4>{{ title }}</h4>
    <div v-if="!names.length" class="d-empty">{{ none }}</div>
    <div v-for="name in names" :key="name" class="p-row">
        <span>{{ name }}</span>
        <small>{{ counts[name] || 0 }} session{{ counts[name] === 1 ? '' : 's' }}</small>
        <wa-button :class="kind" size="s" appearance="outlined" @click="track(name, kind === 'add')">{{ kind === 'add' ? '+ Add' : 'Remove' }}</wa-button>
    </div>
</template>
