<script setup lang="ts">
// The row's first cell: its title over its next step, with Dismiss (an X) in the gutter at the left where the row has one. The CI pill here shows only where the board is too narrow for the MR column (styles.css).
import { ItemKey, WorkItemsKey, useInjected } from '@/keys';
import CiPill from '@/components/CiPill.vue';
import ItemTitle from './ItemTitle.vue';
import NextLine from './NextLine.vue';
import DismissButton from './DismissButton.vue';

const item = useInjected(ItemKey);
const { canDismiss } = useInjected(WorkItemsKey);
</script>

<template>
    <td class="what">
        <DismissButton v-if="canDismiss(item)" />
        <CiPill :pipeline="item.prState?.pipeline" narrow />
        <ItemTitle />
        <NextLine />
    </td>
</template>
