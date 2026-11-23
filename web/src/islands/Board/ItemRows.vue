<script setup lang="ts">
// One work item's row, plus its detail row while selected. Its parts read the item through ItemKey.
import { provide, toRef } from 'vue';
import { ago } from 'old/core.js';
import { ItemKey, SelectionKey, WorkItemsKey, useInjected } from '@/keys';
import ItemWhat from './ItemWhat.vue';
import ItemProgress from './ItemProgress.vue';
import PrParts from './PrParts.vue';
import ItemActions from './ItemActions.vue';
import ItemDetail from './ItemDetail.vue';

const props = defineProps<{ id: string }>();
const { byKey } = useInjected(WorkItemsKey);
const { selected, toggle } = useInjected(SelectionKey);
// looked up on every read, so the row follows each redraw of the old page, also one that changed the item in place
const item = toRef(() => byKey.value.get(props.id)!);
provide(ItemKey, item);
</script>

<template>
    <tr :class="{ sel: selected === id }" :data-key="id" @click="toggle(item)">
        <ItemWhat />
        <ItemProgress />
        <td class="pr"><PrParts /></td>
        <td class="br"><span v-if="item.branch" class="chip mono">{{ item.branch }}</span></td>
        <ItemActions />
        <td class="when">{{ item.updated ? ago(item.updated) : '' }}</td>
    </tr>
    <tr v-if="selected === id" class="detail">
        <td colspan="6"><ItemDetail /></td>
    </tr>
</template>
