<script setup lang="ts">
// A file's diff rows with old and new line numbers, drawn LINES at a time. Diff text only ever reaches text nodes.
import { ref, watch } from 'vue';

const LINES = 500; // drawn at a time; "Show more" adds the next ones
const CLS = { h: 'hunk', '+': 'add', '-': 'del', m: 'meta', ' ': '' };

const props = defineProps<{ rows: DiffRow[] }>();
const drawn = ref(LINES);

watch(() => props.rows, () => { drawn.value = LINES; });
</script>

<template>
    <div class="dv-lines mono">
        <div v-for="(r, i) in rows.slice(0, drawn)" :key="i" class="dv-l" :class="CLS[r.t]"><span class="dv-n">{{ r.o }}</span><span class="dv-n">{{ r.n }}</span><span class="dv-t">{{ (r.t === 'h' || r.t === 'm' ? '' : r.t) + r.text }}</span></div>
    </div>
    <button v-if="rows.length > drawn" class="dv-btn dv-more" type="button" @click="drawn += LINES">Show more ({{ rows.length - drawn }} lines left)</button>
</template>
