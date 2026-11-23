<script setup lang="ts">
// The row's buttons in fixed slots (Changes, chat, one-click command or that it was sent), so they line up on every row, filled or not.
import { ItemKey, useInjected } from '@/keys';
import DiffIcon from '@/components/DiffIcon.vue';
import SentPill from './SentPill.vue';
import ActionButton from './ActionButton.vue';
import StepInButton from './StepInButton.vue';

const item = useInjected(ItemKey);
</script>

<template>
    <td class="act">
        <span class="slots">
            <span class="sl sl-i"><DiffIcon :item="item" /></span>
            <span class="sl sl-i"><StepInButton /></span>
            <span class="sl sl-b">
                <SentPill v-if="item.sent || item.requested" />
                <ActionButton v-else-if="item.action && item.sessionId" />
                <small v-else-if="item.note" class="muted">{{ item.note }}</small>
            </span>
        </span>
    </td>
</template>
