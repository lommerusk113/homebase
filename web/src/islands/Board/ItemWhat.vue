<script setup lang="ts">
// The row's first cell: its title over its next step. The CI pill here shows only where the board is too narrow for the MR column (styles.css).
import { ItemKey, useInjected } from '@/keys';
import CiPill from '@/components/CiPill.vue';
import ItemTitle from './ItemTitle.vue';
import NextLine from './NextLine.vue';

const item = useInjected(ItemKey);
</script>

<template>
    <td class="what">
        <CiPill :pipeline="item.prState?.pipeline" narrow />
        <ItemTitle />
        <NextLine />
    </td>
</template>
