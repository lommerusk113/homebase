<script setup lang="ts">
// A command and a hint of its result: the result itself when it is short, else how many lines it has.
import { computed } from 'vue';

const props = defineProps<{ item: ChatItem; long: boolean }>();
const lines = computed(() => props.item.text.split('\n').length);
</script>

<template>
    <div class="c-cmd">
        <span class="mono">{{ item.cmd }}</span>
        <span v-if="item.text" class="c-result">{{ long ? ` · ${lines} line${lines > 1 ? 's' : ''}` : ` · ${item.text}` }}</span>
    </div>
</template>
