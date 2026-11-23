<script setup lang="ts">
// The project picker: a button showing the picked project that opens a filterable list (a popover; a bottom sheet on phones).
import { useTemplateRef } from 'vue';
import { useEventListener } from '@vueuse/core';
import { PickerKey, useInjected } from '@/keys';
import PickButton from './PickButton.vue';
import PickPanel from './PickPanel.vue';

const { isOpen, close } = useInjected(PickerKey);
const wrap = useTemplateRef('wrap');

// outside: a click elsewhere, or focus moving out with Tab
useEventListener(document, 'click', e => {
    if (isOpen.value && wrap.value && !e.composedPath().includes(wrap.value)) {
        close(false);
    }
});

function focusLeft(e: FocusEvent) {
    if (e.relatedTarget instanceof Node && !wrap.value?.contains(e.relatedTarget)) {
        close(false);
    }
}
</script>

<template>
    <span ref="wrap" class="pp" :class="{ open: isOpen }" @focusout="focusLeft">
        <PickButton />
        <PickPanel />
    </span>
</template>
