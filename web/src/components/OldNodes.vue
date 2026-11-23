<script setup lang="ts">
// DOM built by an old-page helper (public/*.js), shown inside an island until that helper is ported too. The same
// array again leaves the nodes as they are.
import { ref, watchPostEffect } from 'vue';

const props = defineProps<{ nodes: Node[] }>();
const host = ref<HTMLElement>();
watchPostEffect(() => host.value?.replaceChildren(...props.nodes));
</script>

<template>
    <span ref="host" class="contents" />
</template>
