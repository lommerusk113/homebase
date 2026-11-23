<script setup lang="ts">
import { NewProjectKey, useInjected } from '@/keys';
import type { Mode } from '@/composables/useNewProject';

const { mode, setMode } = useInjected(NewProjectKey);
const TABS: { id: Mode; label: string }[] = [{ id: 'new', label: 'New repo' }, { id: 'gh', label: 'From my GitHub' }, { id: 'open', label: 'Open folder' }];
</script>

<template>
    <div class="np-tabs">
        <wa-button v-for="t in TABS" :key="t.id" :id="`np-tab-${t.id}`" size="s" variant="brand" :appearance="mode === t.id ? 'accent' : 'outlined'" @click="setMode(t.id)">{{ t.label }}</wa-button>
    </div>
</template>
