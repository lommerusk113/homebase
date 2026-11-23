<script setup lang="ts">
import { ProjectsKey, useInjected } from '@/keys';

const { canPair, newProject, openFolder, pair, log } = useInjected(ProjectsKey);
</script>

<template>
    <div class="d-new">
        <wa-button class="d-new-btn" size="s" variant="brand" appearance="outlined" @click="newProject">New project…</wa-button>
        <wa-button class="d-open-btn" size="s" variant="brand" appearance="outlined" @click="openFolder">Open existing folder…</wa-button>
        <wa-button v-if="canPair" class="d-pair-btn" size="s" variant="brand" appearance="outlined" @click="pair">Pair a device…</wa-button>
        <wa-button class="d-log-btn" size="s" variant="brand" appearance="outlined" title="What happened in the selected project in the last 7 days (l)" @click="log">Activity log…</wa-button>
    </div>
</template>
