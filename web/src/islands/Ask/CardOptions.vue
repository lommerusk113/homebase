<script setup lang="ts">
// A card's options. Picking one disables them all (the picked one spins) until the card is drawn again, so a double
// tap answers once.
import { ref, watch } from 'vue';
import { SendKey, useInjected } from '@/keys';
import type { Card } from '@/composables/useAsk';
import OptionButton from './OptionButton.vue';

const props = defineProps<{ card: Card | null }>();
const { focusComposer, showError } = useInjected(SendKey);
const picked = ref<number | null>(null);

watch(() => props.card, () => { picked.value = null; });

async function pick(e: MouseEvent, n: number) {

    focusComposer(e);
    showError('');
    picked.value = n;

    await props.card?.answer?.(n).catch((err: Error) => showError(err.message));
}
</script>

<template>
    <div class="c-opts">
        <OptionButton v-for="(option, n) in card?.options" :key="n" :option="option" :n="n" :readonly="!card?.answer" :disabled="picked !== null" :loading="picked === n" @click="pick($event, n)" />
    </div>
</template>
