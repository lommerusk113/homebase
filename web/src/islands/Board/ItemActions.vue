<script setup lang="ts">
// The row's buttons: Changes, then its one-click command (or that it was sent), and Dismiss where there is no MR to act on.
import { ItemKey, WorkItemsKey, useInjected } from '@/keys';
import DiffIcon from '@/components/DiffIcon.vue';
import SentPill from './SentPill.vue';
import ActionButton from './ActionButton.vue';
import DismissButton from './DismissButton.vue';

const item = useInjected(ItemKey);
const { canDismiss } = useInjected(WorkItemsKey);
</script>

<template>
    <td class="act">
        <DiffIcon :item="item" />
        <SentPill v-if="item.sent || item.requested" />
        <ActionButton v-else-if="item.action && item.sessionId" />
        <DismissButton v-if="canDismiss(item)" />
    </td>
</template>
