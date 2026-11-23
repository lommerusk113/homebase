<script setup lang="ts">
import { ProjectKey, useInjected } from '@/keys';
import { Button } from '@/components/ui/button';

const { setProject } = useInjected(ProjectKey);
</script>

<template>
    <Button size="xs" variant="outline" @click="setProject('all')">All projects</Button>
</template>
