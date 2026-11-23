<script setup lang="ts">
// The milestone pill: "⚑ Supplier automation · 11 open · 1 Dec" with a mini bar; its menu switches milestones, which
// filters the board and fills the Issues tab. No pill for "All my projects", none (and no gap) without milestones.
import { computed, ref, useTemplateRef } from 'vue';
import { useEventListener } from '@vueuse/core';
import { MilestoneFilterKey, useInjected } from '@/keys';
import PillSummary from './PillSummary.vue';
import PillMenu from './PillMenu.vue';

const { data, busy, empty } = useInjected(MilestoneFilterKey);
const pick = useTemplateRef('pick');
const open = ref(false);

// no milestones: the answer is the user's own issues, which the Issues tab shows without the pill
const bare = computed(() => !!data.value && !data.value.milestones.length && !data.value.loading && (!data.value.reason || data.value.reason === 'none'));

// a details menu doesn't close on outside clicks by itself
useEventListener(document, 'click', e => {
    if (open.value && pick.value && !e.composedPath().includes(pick.value)) {
        open.value = false;
    }
});

// Tab out of the menu closes it: left open it covers the board, out of Escape's reach
function focusLeft(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && !pick.value?.contains(e.relatedTarget)) {
        open.value = false;
    }
}

// choosing an entry closes the menu
function chosen(e: MouseEvent) {
    if ((e.target as Element).closest('button')) {
        open.value = false;
    }
}
</script>

<template>
    <span id="milestone-slot" :hidden="bare || data?.reason === 'unsupported'">
        <details
            v-if="data !== null"
            ref="pick"
            class="ms-pick"
            :class="{ off: !!empty || bare, err: !!empty?.err, busy: busy != null }"
            :open
            @toggle="open = pick?.open ?? false"
            @focusout="focusLeft"
            @keydown.esc.stop="open = false"
        >
            <PillSummary />
            <PillMenu @click="chosen" />
        </details>
    </span>
</template>
