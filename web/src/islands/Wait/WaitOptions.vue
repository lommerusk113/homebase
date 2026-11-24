<script setup lang="ts">
// The strip's chips. A tap sends its answer and disables them all (the tapped one spins) so a double tap sends once; a
// failed send enables them again. Answered, the strip goes once the transcript shows it.
import { computed, ref, watch } from 'vue';
import { SendKey, WaitKey, useInjected } from '@/keys';
import OptButton from '@/components/OptButton.vue';

const { waiting, answer } = useInjected(WaitKey);
const { focusComposer } = useInjected(SendKey);
const YES_NO = /(?:^|[.!?:—–]\s+)(?:should|shall|do|does|did|is|are|can|could|will|would|want|may)\b[^?]*\?/i;
const picked = ref<number | null>(null);
const options = computed(() => {
    const r = waiting.value?.reply;

    const named = r?.ask?.options ?? (r?.replies ?? []).map(label => ({ label, desc: '' }));

    // ponytail: no listed options and a yes/no question ("Should I …?") → Yes / No; numbered options are not parsed
    return named.length || !YES_NO.test(r?.ask?.question ?? r?.waiting ?? '') ? named : ['Yes', 'No'].map(label => ({ label, desc: '' }));
});

watch(() => waiting.value?.key, () => { picked.value = null; });

async function pick(e: MouseEvent, n: number) {

    if (picked.value !== null) {
        return;
    }
    focusComposer(e);
    picked.value = n;

    if (!await answer(options.value[n].label)) {
        picked.value = null;
    }
}
</script>

<template>
    <div class="c-opts" id="wait-opts">
        <OptButton v-for="(o, n) in options" :key="n" :label="o.label" :n="n" :desc="o.desc" :disabled="picked !== null" :loading="picked === n" @click="pick($event, n)" />
    </div>
</template>
