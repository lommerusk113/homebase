<script setup lang="ts">
// One file of the list: its status letter, path (the folder part gives way to the name) and added/removed counts.
import { computed, useTemplateRef, watch } from 'vue';
import { DiffKey, useInjected } from '@/keys';
import type { DiffGroup } from '@/composables/useDiff';

const props = defineProps<{ group: DiffGroup; file: DiffFile }>();
const { isPicked, pick } = useInjected(DiffKey);
const button = useTemplateRef<HTMLElement>('button');
const me = computed(() => ({ group: props.group, path: props.file.path }));
const picked = computed(() => isPicked(me.value));
const slash = computed(() => props.file.path.lastIndexOf('/') + 1);

watch(picked, on => on && button.value?.scrollIntoView({ block: 'nearest' }), { flush: 'post', immediate: true });
</script>

<template>
    <button ref="button" class="dv-file" type="button" :data-group="group" :data-path="file.path" :title="file.path" :aria-current="picked" @click="pick(me)">
        <span class="dv-st" :class="`st-${/[A-Z]/.test(file.status) ? file.status : 'new'}`">{{ file.status }}</span>
        <span class="dv-name"><span class="dv-dir">{{ file.path.slice(0, slash) }}</span><span class="dv-base">{{ file.path.slice(slash) }}</span></span>
        <span class="dv-counts">
            <template v-if="file.binary">binary</template>
            <template v-else-if="file.add != null"><span class="dv-add">+{{ file.add }}</span>{{ ' ' }}<span class="dv-del">−{{ file.del }}</span></template>
            <template v-else-if="file.status === '?'">new</template>
        </span>
    </button>
</template>
