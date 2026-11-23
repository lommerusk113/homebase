<script setup lang="ts">
// A message: the user's on the right, Claude's as a card. Only Claude's newest reply can be waiting on the user (needs);
// an older one reads as a plain card (fyi).
import { computed, ref, useId } from 'vue';
import { topicHue } from 'old/chat.js';
import { FeedKey, UnreadKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';
import AnswerTag from './AnswerTag.vue';
import AssistantBody from './AssistantBody.vue';
import BubbleTopic from './BubbleTopic.vue';
import NoteRow from './NoteRow.vue';
import Replies from './Replies.vue';
import UserBody from './UserBody.vue';

const props = defineProps<{ row: BubbleRow }>();
const { view } = useInjected(FeedKey);
const { markRead } = useInjected(UnreadKey);

const i = computed(() => props.row.item);
const key = computed(() => `${view.value.sid}:${i.value.at}`);
const claude = computed(() => i.value.role === 'assistant');
const needs = computed(() => claude.value && !!i.value.needsYou && !i.value.error && props.row.latest);
// the topic only where it changes from Claude's previous bubble, so a run on one task reads as one block
const head = computed(() => !!i.value.topic && i.value.topic !== props.row.prevTopic);
const kind = computed(() => (!claude.value || i.value.error ? [] : needs.value ? ['needs'] : ['fyi', { latest: props.row.latest }]));
const enter = !view.value.first; // only a bubble new since the last drawing rises in
const tipId = `feed-${useId()}`;
const opened = ref(false);

function read() { // a click or the focus arriving: reading by keyboard counts, Show more included
    if (needs.value) {
        markRead(view.value.sid, key.value);
        opened.value = true;
    }
}
</script>

<template>
    <div
        :id="i.interrupted ? tipId : undefined"
        :class="['bubble', i.role, kind, { failed: i.error || (i as OutboxItem).unconfirmed, interrupted: i.interrupted, topical: i.topic, canned: !claude && i.label, enter }]"
        :style="i.topic ? { '--tc': `var(--t${topicHue(i.topic)})` } : undefined"
        :role="claude || i.role === 'user' ? 'group' : undefined"
        :aria-label="claude ? (needs ? 'Claude, needs you' : 'Claude') : i.role === 'user' ? 'You' : undefined"
        :title="i.at && !i.interrupted && !head && !needs ? new Date(i.at).toLocaleString() : undefined"
        :tabindex="needs ? 0 : undefined"
        :data-key="key"
        @click="read"
        @focusin="read"
    >
        <BubbleTopic v-if="head || needs" :row="row" :head="head" :needs="needs" :unread="row.unread && !opened" />
        <AssistantBody v-if="claude" :row="row" />
        <UserBody v-else :row="row" />
        <Replies v-if="row.replies" :row="row" />
        <AnswerTag v-if="i.answer" :answer="i.answer" />
        <wa-tooltip v-if="i.interrupted" :for="tipId">Interrupted by you</wa-tooltip>
        <NoteRow :row="row" />
    </div>
</template>
