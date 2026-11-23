<script setup lang="ts">
// The row's buttons: Changes, then its one-click command (or that it was sent).
import { ItemKey, useInjected } from '@/keys';
import DiffIcon from '@/components/DiffIcon.vue';
import SentPill from './SentPill.vue';
import ActionButton from './ActionButton.vue';

const item = useInjected(ItemKey);
</script>

<template>
    <td class="act">
        <DiffIcon :item="item" />
        <SentPill v-if="item.sent || item.requested" />
        <ActionButton v-else-if="item.action && item.sessionId" />
    </td>
</template>
