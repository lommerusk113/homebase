<script setup lang="ts">
// Fixed-height line at the top of the composer: what Claude is doing, then the model, the context use and "Compact?".
import { watch } from 'vue';
import { ChatActionsKey, StatusKey, useInjected } from '@/keys';
import { announce } from '@/lib/page';
import ModelPicker from './ModelPicker.vue';
import ContextUse from './ContextUse.vue';

const { status, needsAnswer, jumpToNeeds, NEEDS_ANSWER } = useInjected(StatusKey);
const { compactDue, confirm } = useInjected(ChatActionsKey);

// the line itself is no live region: a working chat's step changes would be read out all day
watch(() => status.value.kind, kind => {
    if (kind === 'error' || kind === 'stuck') {
        announce(status.value.text);
    }
});
</script>

<template>
    <div class="c-status" :class="status.kind" id="status">
        <span class="pulse"></span>
        <span id="status-text">
            <template v-if="needsAnswer"><button class="show" type="button" @click="jumpToNeeds">{{ NEEDS_ANSWER }}</button>{{ status.text.slice(NEEDS_ANSWER.length) }}</template>
            <template v-else>{{ status.text }}</template>
        </span>
        <button class="c-compact" id="status-restart" type="button" :hidden="status.kind !== 'stuck'" @click="confirm('restart')">Restart chat</button>
        <ModelPicker />
        <ContextUse />
        <button class="c-compact" id="compact-nudge" type="button" :hidden="!compactDue" @click="confirm('compact')">Compact?</button>
    </div>
</template>
