<script setup lang="ts">
import { NewProjectKey, useInjected } from '@/keys';

const { steps } = useInjected(NewProjectKey);
</script>

<template>
    <ol class="np-steps" id="np-steps" :hidden="!steps">
        <li v-for="s in steps" :key="s.id" :class="s.state" :data-step="s.id">{{ s.label }}</li>
    </ol>
</template>
