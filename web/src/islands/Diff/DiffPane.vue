<script setup lang="ts">
// The picked file: its path with "Copy path", then its diff or a note in its place.
import { ref, useTemplateRef, watch } from 'vue';
import { DiffKey, useInjected } from '@/keys';
import DiffLines from './DiffLines.vue';

const { sel, pane, empty } = useInjected(DiffKey);
const code = useTemplateRef<HTMLElement>('code');
const copied = ref(false);

function copy() {
    navigator.clipboard.writeText(sel.value?.path ?? '').then(() => {
        copied.value = true;
        setTimeout(() => { copied.value = false; }, 1500);
    });
}

watch(pane, () => code.value?.scrollTo(0, 0), { flush: 'post' });
</script>

<template>
    <section class="dv-pane">
        <div class="dv-phead" :hidden="empty || !sel">
            <span class="dv-path mono">{{ sel?.path }}</span>
            <button class="dv-btn dv-copy" type="button" @click="copy">{{ copied ? 'Copied' : 'Copy path' }}</button>
        </div>
        <div ref="code" class="dv-code">
            <DiffLines v-if="'rows' in pane" :rows="pane.rows" />
            <div v-else class="dv-note">{{ pane.note }}</div>
        </div>
    </section>
</template>
