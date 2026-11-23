<script setup lang="ts">
// The message box. Enter sends and Shift+Enter adds a line; on a touch screen Enter adds a line, as its keyboard has no
// Shift+Enter, and the send button (shown there only) sends. A pasted image is attached; a long paste becomes a label.
import { useTemplateRef, watch } from 'vue';
import { AttachmentsKey, ComposerKey, useInjected } from '@/keys';

const { text, caret, label, hint, typed, paste, submit, entersLine, focusAsked } = useInjected(ComposerKey);
const { attach } = useInjected(AttachmentsKey);
const box = useTemplateRef<WaTextarea>('box');
// the selection lives on the component's inner <textarea>
const selection = () => ({ start: box.value?.input?.selectionStart, end: box.value?.input?.selectionEnd });

function input() {
    const { start, end } = selection();
    typed(box.value!.value, start, end);
}

function keydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !entersLine()) {
        e.preventDefault();
        submit();
    }
}

function pasted(e: ClipboardEvent) {

    const files = [...e.clipboardData?.files ?? []].filter(f => f.type.startsWith('image/'));
    if (files.length) {
        e.preventDefault(); // not also the file's name as text
        attach(files);
        return;
    }

    const start = selection().start ?? box.value!.value.length;
    if (paste(e.clipboardData?.getData('text/plain') ?? '', start, selection().end ?? start)) {
        e.preventDefault();
    }
}

watch(focusAsked, () => box.value?.focus({ preventScroll: true }), { flush: 'sync' });
// once the component has rendered the value
watch(caret, async c => {
    await box.value?.updateComplete;
    if (c && c === caret.value) {
        box.value?.setSelectionRange(c.start, c.end);
    }
}, { immediate: true, flush: 'post' });
</script>

<template>
    <wa-textarea ref="box" id="msg" :label.attr="label" rows="1" resize="auto" :placeholder.attr="hint" title="Enter sends, Shift+Enter adds a new line"
        .value="text" @input="input" @keydown="keydown" @paste="pasted"></wa-textarea>
</template>
