<script setup lang="ts">
// Markdown as the old page draws it (core.js rich): sanitised, MR links as chips, paths as code, and a huge table or
// code block cut to its first rows with "Show all". inline: one line, no paragraphs. The class comes from the caller.
import { onMounted, useTemplateRef, watch } from 'vue';
import { rich } from 'old/core.js';

const props = defineProps<{ text: string; inline?: boolean; tag?: string }>();
const root = useTemplateRef<HTMLElement>('root');
// the nodes are rich()'s own (its Show all buttons work on them); Vue has no children here to patch over them
const fill = () => root.value?.replaceChildren(...rich(props.text, props.inline).childNodes);

onMounted(fill);
watch(() => [props.text, props.inline], fill, { flush: 'post' });
</script>

<template>
    <component :is="tag ?? 'div'" ref="root" />
</template>
