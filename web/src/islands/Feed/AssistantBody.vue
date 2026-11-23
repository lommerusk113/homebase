<script setup lang="ts">
// Claude's reply: its TLDR, the rest behind Show more. A question's options stay out of the fold, and so does the
// newest reply's Heads-up; an older reply's Heads-up goes into its fold.
import { computed } from 'vue';
import { FeedKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';
import FoldText from '@/components/FoldText.vue';
import RichText from '@/components/RichText.vue';

const props = defineProps<{ row: BubbleRow }>();
const { view } = useInjected(FeedKey);
const i = computed(() => props.row.item);
const rest = computed(() => (i.value.headsUp && !props.row.latest ? `**Heads-up:** ${i.value.headsUp}\n\n` : '')
    + (i.value.options ? i.value.text.replace(i.value.options, '') : i.value.text));
</script>

<template>
    <FoldText :tldr="i.tldr" :rest="rest" :fold-key="`${view.sid}:${i.at}`">
        <div v-if="i.headsUp && row.latest" class="b-heads"><b>{{ 'Heads-up: ' }}</b><RichText tag="span" inline :text="i.headsUp" /></div>
        <RichText v-if="i.options" class="body b-options" :text="i.options" />
    </FoldText>
</template>
