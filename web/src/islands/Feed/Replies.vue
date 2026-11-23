<script setup lang="ts">
// Quick replies under a question of Claude's. A tap sends its answer; the chips stay disabled meanwhile, so a double
// tap sends once. Sent, the row goes once the answer shows; a failed send enables them again.
import { ref } from 'vue';
import { FeedKey, SendKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';
import OptButton from '@/components/OptButton.vue';

const props = defineProps<{ row: BubbleRow }>();
const { view } = useInjected(FeedKey);
const { send, focusComposer } = useInjected(SendKey);
const sending = ref<number | null>(null);

async function pick(e: Event, label: string, n: number) {
    focusComposer(e);
    if (sending.value !== null) {
        return;
    }
    sending.value = n;
    if (!await send(view.value.sid, label, props.row.item.at, props.row.replies?.note)) {
        sending.value = null;
    }
}
</script>

<template>
    <div class="replies">
        <OptButton
            v-for="(label, n) in row.replies?.labels"
            :key="n"
            :label="label"
            :n="n"
            :disabled="sending !== null"
            :loading="sending === n"
            @click="pick($event, label, n)"
        />
    </div>
</template>
