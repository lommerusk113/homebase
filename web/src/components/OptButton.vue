<script setup lang="ts">
// A big option button: a number badge (a digit key picks it, keys.js) and the label, its "(Recommended)" shown as a badge instead.
import { computed } from 'vue';

const props = defineProps<{ label: string; n: number; disabled?: boolean; loading?: boolean }>();
const rec = computed(() => /\(recommended\)/i.test(props.label));
const text = computed(() => props.label.replace(/\s*\(recommended\)/i, ''));
// attributes, not properties, so they hold before the element is upgraded
const flag = (on?: boolean) => (on ? '' : undefined);
</script>

<template>
    <wa-button
        :class="['c-opt', { primary: rec }]"
        size="s"
        :variant="rec ? 'brand' : 'neutral'"
        :appearance="rec ? 'accent' : 'outlined'"
        :disabled.attr="flag(disabled)"
        :loading.attr="flag(loading)"
    >{{ text }}<span class="k" slot="start">{{ n + 1 }}</span><span v-if="rec" class="rec" slot="end">Recommended</span></wa-button>
</template>
