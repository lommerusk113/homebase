<script setup lang="ts">
// "issue — what led here — question — (1) … (2) …": the question on top (a click shows its reply), the rest muted and
// clamped (a click shows all), the options as chips.
import { ref, watch } from 'vue';
import { jumpToNeeds } from 'old/chat.js';
import { WaitKey, useInjected } from '@/keys';
import RichText from '@/components/RichText.vue';
import WaitOptions from './WaitOptions.vue';

const { waiting } = useInjected(WaitKey);
const clamped = ref(true);

watch(() => waiting.value?.key, () => { clamped.value = true; });
</script>

<template>
    <div class="c-note c-wait" id="wait" :hidden="!waiting" :data-key="waiting && `${waiting.sid}:${waiting.reply.at}`">
        <template v-if="waiting">
            <RichText tag="button" class="c-wait-q" id="wait-q" type="button" title="Show the reply this is about" :text="waiting.reply.ask?.question ?? waiting.reply.waiting ?? ''" inline @click="jumpToNeeds" />
            <RichText class="c-wait-ctx" :class="{ clamp: clamped }" id="wait-ctx" title="Show all" :text="waiting.reply.ask?.context ?? ''" inline :hidden="!waiting.reply.ask?.context" @click="clamped = !clamped" />
            <WaitOptions />
        </template>
    </div>
</template>
