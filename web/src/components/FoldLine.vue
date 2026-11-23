<script setup lang="ts">
// One line that opens: the line (#line), its Show more next to it, the body under them. The default slot is the body:
// one element, which takes the slot's `hidden`.
import { computed, nextTick, useTemplateRef } from 'vue';
import { UnfoldKey, useInjected } from '@/keys';
import FoldButton from '@/components/FoldButton.vue';

const props = defineProps<{ foldKey: string }>();
const { isOpen, toggle } = useInjected(UnfoldKey);
const box = useTemplateRef<HTMLElement>('box');
const open = computed(() => isOpen(props.foldKey));

function flip() {
    if (toggle(props.foldKey)) {
        nextTick(() => box.value?.lastElementChild?.scrollIntoView({ block: 'nearest' })); // text taller than the pane starts at its top
    }
}
</script>

<template>
    <div ref="box" class="fold-line">
        <slot name="line" />
        <FoldButton :open="open" @toggle="flip" />
        <slot :hidden="!open" />
    </div>
</template>
