<script setup lang="ts">
// One option of a question card. readonly: a plain row, where there is no pane to answer on. quiet: a text button with
// no number, for "Chat about this" and a grant, whose scope stays readable.
import type { CardOption } from '@/composables/useAsk';
import OptButton from '@/components/OptButton.vue';

defineProps<{ option: CardOption; n: number; readonly?: boolean; disabled?: boolean; loading?: boolean }>();
const flag = (on?: boolean) => (on ? '' : undefined); // attributes, as OptButton sets them
</script>

<template>
    <div v-if="readonly" class="c-opt ro">{{ option.label.replace(/\s*\(recommended\)/i, '') }}<span class="k">{{ n + 1 }}</span><small v-if="option.desc">{{ option.desc }}</small><span v-if="/\(recommended\)/i.test(option.label)" class="rec">Recommended</span></div>
    <wa-button v-else-if="option.quiet" class="c-opt quiet" size="s" appearance="plain" variant="neutral" :disabled.attr="flag(disabled)" :loading.attr="flag(loading)">{{ option.desc ? `${option.label} ${option.desc}` : option.label }}</wa-button>
    <OptButton v-else :label="option.label" :n="n" :desc="option.desc" :disabled="disabled" :loading="loading" />
</template>
