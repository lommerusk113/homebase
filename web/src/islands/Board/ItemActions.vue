<script setup lang="ts">
// The row's buttons in fixed slots (Changes, chat, one-click command, that it was sent, or Stop on a helper in its own chat), so they line up on every row, filled or not.
import { ItemKey, useInjected } from '@/keys';
import DiffIcon from '@/components/DiffIcon.vue';
import SentPill from './SentPill.vue';
import ActionButton from './ActionButton.vue';
import StepInButton from './StepInButton.vue';
import StopButton from './StopButton.vue';
import { useHelperStop } from '@/composables/useHelperStop';

const item = useInjected(ItemKey);
const { canStop } = useHelperStop();
</script>

<template>
    <td class="act">
        <span class="slots">
            <span class="sl sl-i"><DiffIcon :item="item" /></span>
            <span class="sl sl-i"><StepInButton /></span>
            <span class="sl sl-b">
                <SentPill v-if="item.sent || item.requested" />
                <ActionButton v-else-if="item.action && item.sessionId" />
                <StopButton v-else-if="canStop(item)" />
                <small v-else-if="item.note" class="muted">{{ item.note }}</small>
            </span>
        </span>
    </td>
</template>
