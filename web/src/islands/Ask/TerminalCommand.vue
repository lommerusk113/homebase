<script setup lang="ts">
// The command that opens a chat's terminal, with a Copy button.
import { computed, ref } from 'vue';

defineOptions({ inheritAttrs: false });
const props = defineProps<{ tmux?: string }>();
const command = computed(() => `tmux attach -t ${props.tmux ?? ''}`);
const copied = ref(false);

async function copy() {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
    <code class="mono" v-bind="$attrs">{{ command }}</code>
    <wa-button size="s" appearance="plain" class="c-copy" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</wa-button>
</template>
