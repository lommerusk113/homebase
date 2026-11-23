<script setup lang="ts">
// What the user sent. A button's message: the action on one line, what it typed behind it. Else the text, cut with
// "Show more" where it is long, and its images as pictures instead of their paths.
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { FeedKey, ImagesKey, UnfoldKey, useInjected } from '@/keys';
import type { BubbleRow } from '@/composables/useFeed';
import FoldButton from '@/components/FoldButton.vue';
import FoldLine from '@/components/FoldLine.vue';
import RichText from '@/components/RichText.vue';
import BubbleImages from './BubbleImages.vue';

const props = defineProps<{ row: BubbleRow }>();
const { view } = useInjected(FeedKey);
const images = useInjected(ImagesKey);
const { isOpen, toggle } = useInjected(UnfoldKey);
const body = useTemplateRef<InstanceType<typeof RichText>>('body');

const i = computed(() => props.row.item);
const key = computed(() => `${view.value.sid}:${i.value.at}`);
const text = computed(() => images.withoutLines(i.value.text));
const names = computed(() => images.names(i.value.text));
const open = computed(() => isOpen(key.value));
const cut = ref(false), fits = ref(false); // the fold cuts something off (so there is a button), or nothing (so there is no fold)

// needs layout, so after the text is in the page
// ponytail: looked at when the text changes, not when the pane's width does; a later message's bubble is measured fresh
async function measure() {
    cut.value = fits.value = false;
    await nextTick();
    const el: HTMLElement | undefined = body.value?.$el;
    if (el && !open.value) {
        cut.value = el.scrollHeight > el.clientHeight + 4;
        fits.value = !cut.value;
    }
}
onMounted(measure);
watch(text, measure);

function flip() {
    if (toggle(key.value)) {
        nextTick(() => body.value?.$el.scrollIntoView({ block: 'nearest' })); // text taller than the pane starts at its top
    }
}
</script>

<template>
    <FoldLine v-if="i.label" :fold-key="key">
        <template #line><div class="body">{{ i.label }}</div></template>
        <template #default="{ hidden }"><RichText class="body" :text="i.text" :hidden="hidden" /></template>
    </FoldLine>
    <template v-else>
        <RichText v-if="text || !names.length" ref="body" :class="['body', { fold: !open && !fits }]" :text="text" />
        <FoldButton v-if="cut" :open="open" @toggle="flip" />
        <BubbleImages v-if="names.length" :names="names" />
    </template>
</template>
