<script setup lang="ts">
// A slash command or `!` bash line on one line, opening to the panel or output as the terminal drew it.
// Several in a row: one line that opens to the list.
import { computed } from 'vue';
import { FeedKey, useInjected } from '@/keys';
import FoldLine from '@/components/FoldLine.vue';
import CommandHead from './CommandHead.vue';

const props = defineProps<{ run: ChatItem[] }>();
const { view } = useInjected(FeedKey);
const first = computed(() => props.run[0]);
const many = computed(() => props.run.length > 1);
const key = computed(() => `${view.value.sid}:${first.value.at}:${many.value ? 'cmds' : first.value.cmd}`);
const long = computed(() => first.value.text.includes('\n') || first.value.text.length > 80);
</script>

<template>
    <div class="tools detail command" :data-key="key">
        <FoldLine v-if="many" :fold-key="key">
            <template #line><div class="c-cmd">{{ run.length }} commands</div></template>
            <template #default="{ hidden }">
                <div class="c-cmds" :hidden="hidden"><CommandLine v-for="(c, n) in run" :key="n" :run="[c]" /></div>
            </template>
        </FoldLine>
        <template v-else>
            <FoldLine v-if="long" :fold-key="key">
                <template #line><CommandHead :item="first" long /></template>
                <template #default="{ hidden }"><pre class="c-panel mono" :hidden="hidden">{{ first.text }}</pre></template>
            </FoldLine>
            <CommandHead v-else :item="first" :long="false" />
            <!-- what to do about a picker left open: never folded away -->
            <div v-if="first.hint" class="c-result">{{ first.hint }}</div>
        </template>
    </div>
</template>
