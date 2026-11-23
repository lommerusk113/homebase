<script setup lang="ts">
// Proof of the wiring, shown in the header with ?vue=1: a live count from the old state and a button calling an old action.
import { provide } from 'vue';
import { ProjectKey, SessionsKey } from '@/keys';
import { useSessions } from '@/composables/useSessions';
import { useProject } from '@/composables/useProject';
import ChatCount from './Demo/ChatCount.vue';
import AllProjects from './Demo/AllProjects.vue';

provide(SessionsKey, useSessions());
provide(ProjectKey, useProject());
</script>

<template>
    <span class="inline-flex items-center gap-2" data-island="demo">
        <ChatCount />
        <AllProjects />
    </span>
</template>
