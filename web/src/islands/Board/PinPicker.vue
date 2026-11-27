<script setup lang="ts">
// Moves the row to another group by hand: a small select under the next step, with "pinned" beside it while it holds.
// Auto drops the pin; the pin also drops itself when the row's computed state changes (server/pins.mjs).
import { COLUMNS } from 'old/core.js';
import { ItemKey, WorkItemsKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { pin } = useInjected(WorkItemsKey);

function pick(e: Event) {

    const select = e.target as HTMLSelectElement;
    pin(item.value, select.value as Column | 'auto');
    select.value = item.value.pinned ? item.value.column : 'auto'; // the next poll has the server's word
}
</script>

<template>
    <span class="pin" @click.stop>
        <select class="pin-sel" aria-label="Move to another group" title="Move this row to another group" :value="item.pinned ? item.column : 'auto'" @change="pick">
            <option value="auto">{{ item.pinned ? `Auto (${COLUMNS.find(c => c.key === item.autoColumn)?.label ?? item.autoColumn})` : 'Move to…' }}</option>
            <option v-for="c in COLUMNS" :key="c.key" :value="c.key">{{ c.label }}</option>
        </select>
        <span v-if="item.pinned" class="chip pin-mark" title="Held here until the row changes">pinned</span>
    </span>
</template>
