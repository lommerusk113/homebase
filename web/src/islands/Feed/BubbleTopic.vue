<script setup lang="ts">
// A bubble's top row: its topic, the "needs you" pill (a dot while unread) with ✓ to say Claude got that wrong, and the time.
import { computed } from 'vue';
import { FeedKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';

const props = defineProps<{ row: BubbleRow; head: boolean; needs: boolean; unread: boolean }>();
const { jumpToNeeds, markHandled } = useInjected(FeedKey);
const item = computed(() => props.row.item);

// "10:42" today, "Nov 14 10:42" before
function shortTime(at: string) {
    const d = new Date(at), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}
</script>

<template>
    <div class="b-topic">
        <span v-if="head" class="b-topic-name">{{ item.topic }}</span>
        <template v-if="needs">
            <button type="button" class="need-pill" @click="jumpToNeeds"><span v-if="unread" class="unread" />needs you</button>
            <button v-if="item.id" type="button" class="need-done" title="Mark as handled" aria-label="Mark as handled" @click="markHandled(item.id)">✓</button>
        </template>
        <!-- the full date sits on the time itself, so it doesn't pop up over the whole card; an interrupted bubble has its own tooltip -->
        <span v-if="item.at" class="b-time" :title="item.interrupted ? '' : new Date(item.at).toLocaleString()">{{ shortTime(item.at) }}</span>
    </div>
</template>
