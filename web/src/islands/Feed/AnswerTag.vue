<script setup lang="ts">
// The user's short reply to this question, outside the fold so it shows when collapsed to the TLDR.
import { computed } from 'vue';

const props = defineProps<{ answer: Answer }>();
const yes = computed(() => !/^(no|nope)\b/i.test(props.answer.text));
const note = computed(() => {
    const a = props.answer;
    return a.error ? `Not sent: ${a.error}` : a.unconfirmed ? 'not confirmed — Claude may not have received this' : a.sending ? 'sending…' : a.queued ? 'queued' : null;
});
</script>

<template>
    <div :class="['answer', { yes, failed: answer.error }]"><span class="mark">{{ answer.error ? '!' : yes ? '✓' : '✕' }}</span>{{ ` You: ${answer.text}${note ? ` · ${note}` : ''}` }}</div>
</template>
