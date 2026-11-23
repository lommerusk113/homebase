<script setup lang="ts">
// One entry of the milestone menu; id is what choosing it stores: a milestone id, 'mine' or 'none'.
import { MilestoneFilterKey, useInjected } from '@/keys';

defineProps<{ id: string, label: string, note: string, on?: boolean }>();

const { busy, choose } = useInjected(MilestoneFilterKey);
</script>

<template>
    <button :class="{ on }" :data-id="id" @click="choose(id)">
        <span>{{ label }}</span><small>{{ note }}</small><wa-spinner v-if="busy === id" class="picked" />
    </button>
</template>
