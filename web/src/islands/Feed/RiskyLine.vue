<script setup lang="ts">
// "Ran: git merge …" on one line, cut by the page; Show more (only where something is cut) opens the whole command.
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import { FeedKey, UnfoldKey, useInjected } from '@/keys';
import FoldButton from '@/components/FoldButton.vue';

const props = defineProps<{ text: string; foldKey: string }>();
const { view } = useInjected(FeedKey);
const { isOpen, toggle } = useInjected(UnfoldKey);
const short = useTemplateRef<HTMLElement>('short'), full = useTemplateRef<HTMLElement>('full');

const parts = computed(() => props.text.match(/^([\s\S]*?)( · \d+ failed)?$/) ?? []);
const open = computed(() => isOpen(props.foldKey));
const fits = ref(false);
// needs layout, and the width changes with the pane: looked at again on every drawing of the feed
const measure = () => {
    if (short.value && !open.value) {
        fits.value = short.value.scrollWidth <= short.value.clientWidth;
    }
};

onMounted(measure);
watch(view, measure, { flush: 'post' });

function flip() {
    if (toggle(props.foldKey)) {
        nextTick(() => full.value?.scrollIntoView({ block: 'nearest' }));
    }
}
</script>

<template>
    <div class="fold-line">
        <span ref="short" class="c-ran" :hidden="open">{{ parts[1] }}</span>
        <span v-if="parts[2]" class="c-failed">{{ parts[2] }}</span>
        <FoldButton :open="open" :hidden="fits && !open" @toggle="flip" />
        <div ref="full" class="c-ran-full" :hidden="!open">{{ parts[1] }}</div>
    </div>
</template>
