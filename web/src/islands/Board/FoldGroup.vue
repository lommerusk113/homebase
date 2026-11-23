<script setup lang="ts">
// A group that folds (In review, Recently finished, Merged, Closed), with a muted summary beside its count while folded.
import { computed } from 'vue';
import { COL } from 'old/core.js';
import { BoardGroupsKey, FoldsKey, WorkItemsKey, useInjected } from '@/keys';
import GroupDot from './GroupDot.vue';
import ItemRows from './ItemRows.vue';

const props = defineProps<{ column: Column }>();
const { inColumn } = useInjected(WorkItemsKey);
const { isOpen, setOpen } = useInjected(FoldsKey);
const { note } = useInjected(BoardGroupsKey);
const keys = computed(() => inColumn(props.column).map(x => x.key));
const label = computed(() => COL[props.column].label);

// tooltips inside also fire wa-show/wa-hide, and those bubble
const toggled = (e: Event, open: boolean) => {
    if (e.target === e.currentTarget) {
        setOpen(props.column, open);
    }
};
</script>

<template>
    <wa-details :class="`group g-${column}`" appearance="plain" :open="isOpen(column, keys.length) || null" @wa-show="toggled($event, true)" @wa-hide="toggled($event, false)">
        <!-- a heading like the open groups' h2 -->
        <span slot="summary" class="g-head" role="heading" aria-level="2"><GroupDot :column="column" />{{ label }} ({{ keys.length }})<span v-if="note(column)" class="g-note">{{ ` · ${note(column)}` }}</span></span>
        <table class="rows" role="grid" :aria-label="label">
            <ItemRows v-for="k in keys" :id="k" :key="k" />
        </table>
    </wa-details>
</template>
