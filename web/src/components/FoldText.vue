<script setup lang="ts">
// Collapsed: only the TLDR (or, without one, the lead sentence, hidden while open as it is a cut of the rest).
// Show more reveals the rest. The slot is what stays outside the fold, between the two.
import { computed, nextTick, useTemplateRef } from 'vue';
import { lead } from '@/lib/text';
import { UnfoldKey, useInjected } from '@/keys';
import RichText from '@/components/RichText.vue';
import FoldButton from '@/components/FoldButton.vue';

const props = defineProps<{ tldr?: string | null; rest?: string; foldKey: string }>();
const { isOpen, toggle } = useInjected(UnfoldKey);
const body = useTemplateRef<InstanceType<typeof RichText>>('body');

const head = computed(() => props.tldr || lead(props.rest));
const more = computed(() => (props.tldr || props.rest?.trim() !== head.value ? props.rest?.trim() ?? '' : ''));
const open = computed(() => isOpen(props.foldKey));

function flip() {
    if (toggle(props.foldKey)) {
        nextTick(() => body.value?.$el.scrollIntoView({ block: 'nearest' })); // text taller than the pane starts at its top
    }
}
</script>

<template>
    <RichText class="lead" inline :text="head" :hidden="!!more && !tldr && open" />
    <slot />
    <template v-if="more">
        <RichText ref="body" class="body" :text="more" :hidden="!open" />
        <FoldButton :open="open" @toggle="flip" />
    </template>
</template>
