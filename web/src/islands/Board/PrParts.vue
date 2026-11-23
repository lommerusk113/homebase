<script setup lang="ts">
// MR chip, CI pill, gate badge and the out-of-date warning: the row's MR cell, and on a phone (where that cell is hidden) the top of the detail.
import { computed } from 'vue';
import { forgeWords } from '@/lib/forge';
import { ItemKey, useInjected } from '@/keys';
import PrChip from '@/components/PrChip.vue';
import CiPill from '@/components/CiPill.vue';
import GateBadge from '@/components/GateBadge.vue';
import StaleMark from './StaleMark.vue';

const item = useInjected(ItemKey);
const mr = computed(() => forgeWords(item.value.pr).mr);
</script>

<template>
    <template v-if="item.pr">
        <PrChip :pr="item.pr" :state="item.prState?.state" />
        <CiPill :pipeline="item.prState?.pipeline" />
        <GateBadge v-if="item.gate" :gate="item.gate" :mr="mr" />
        <!-- the lookup failed but an older answer is shown: say it may be out of date (with no answer, Next already says so) -->
        <StaleMark v-if="item.forgeError && item.prState" />
    </template>
</template>
