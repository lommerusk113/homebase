<script setup lang="ts">
// A group that is always open: its work rows, then the chats' own rows (Doing: starting and working; Needs you: asking and stopped).
import { computed } from 'vue';
import { COL } from 'old/core.js';
import { BoardGroupsKey, ChatRowsKey, WorkItemsKey, useInjected } from '@/keys';
import GroupDot from './GroupDot.vue';
import ItemRows from './ItemRows.vue';
import StartingRow from './StartingRow.vue';
import WorkingRow from './WorkingRow.vue';
import AskingRow from './AskingRow.vue';
import DiedRow from './DiedRow.vue';

const props = defineProps<{ column: Column }>();
const { inColumn } = useInjected(WorkItemsKey);
const { starting, working, asking, died } = useInjected(ChatRowsKey);
const { extra } = useInjected(BoardGroupsKey);
const keys = computed(() => inColumn(props.column).map(x => x.key));
const label = computed(() => COL[props.column].label);
</script>

<template>
    <section :class="`group g-${column}`">
        <h2 class="g-head"><GroupDot :column="column" />{{ label }} · {{ keys.length + extra(column) }}</h2>
        <table class="rows" role="grid" :aria-label="label">
            <ItemRows v-for="k in keys" :id="k" :key="k" />
            <!-- after the item rows: a fixed-layout table takes its column widths from the first row, and these span them all -->
            <template v-if="column === 'doing'">
                <StartingRow v-for="p in starting" :key="p.key" :sid="p.sid" :issue="p.n" />
                <WorkingRow v-for="s in working" :key="`working:${s.id}`" :sid="s.id" />
            </template>
            <template v-else-if="column === 'needs-you'">
                <AskingRow v-for="s in asking" :key="`asking:${s.id}`" :sid="s.id" />
                <DiedRow v-for="s in died" :key="`died:${s.id}`" :sid="s.id" />
            </template>
        </table>
    </section>
</template>
