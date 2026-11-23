<script setup lang="ts">
// Under a user bubble: "Not sent" or "Not confirmed" (with Retry and Dismiss), "sending…" or "queued" (with Send now).
import { computed, ref, useId } from 'vue';
import { FeedKey, OutboxKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';

const props = defineProps<{ row: BubbleRow }>();
const { view } = useInjected(FeedKey);
const outbox = useInjected(OutboxKey);
// read off the row, which is new on every drawing: an outbox item is changed in place (sending, then failed or not confirmed)
const note = computed(() => outbox.noteOf(props.row.item));
const lost = computed(() => outbox.lostOf(props.row.item));
const checking = ref(false); // Retry is looking whether a not confirmed message arrived after all
const tipId = `feed-${useId()}`;

async function retry(e: Event) {
    if (!lost.value || checking.value) {
        return;
    }
    checking.value = true;
    await outbox.retry(lost.value, e);
    checking.value = false;
}
</script>

<template>
    <!-- no space between these but the one after the note: the old page's text, which the tests read -->
    <div v-if="note" class="b-note">{{ note }}<template v-if="lost">{{ ' ' }}<wa-button
        v-if="!lost.refused" class="retry" size="s" appearance="outlined" pill :disabled.attr="checking ? '' : undefined" @click="retry"
    >Retry</wa-button><wa-button
        class="dismiss" size="s" appearance="plain" pill @click="outbox.dismiss(lost, $event)"
    >Dismiss</wa-button></template><template v-if="row.item.pending && !row.item.sending"><wa-button
        :id="tipId" class="send-now" size="s" appearance="outlined" pill @click="outbox.sendNow(view.sid, `${view.sid}:${row.item.at}`)"
    >Send now</wa-button><wa-tooltip :for="tipId">Interrupts Claude's current step so your message is handled now</wa-tooltip></template></div>
</template>
