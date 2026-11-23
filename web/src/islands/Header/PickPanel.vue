<script setup lang="ts">
// The picker's list: the filter field (which keeps the focus), the rows, and the actions pinned under them.
import { useTemplateRef, watch } from 'vue';
import { PickerKey, ProjectKey, useInjected } from '@/keys';
import PickRow from './PickRow.vue';

const { newProject, manageProjects } = useInjected(ProjectKey);
const { listId, items, isOpen, query, active, shown, few, revealed, rowId, close, key } = useInjected(PickerKey);
const search = useTemplateRef('search'), list = useTemplateRef('list'), foot = useTemplateRef('foot');
const phone = matchMedia('(max-width: 900px)');

// a phone's keyboard would cover the sheet: it comes up only when the filter field is tapped
watch(isOpen, on => on && (phone.matches ? list.value : search.value)?.focus({ preventScroll: true }), { flush: 'post' });
watch(revealed, () => list.value?.querySelector('.act')?.scrollIntoView({ block: 'nearest' }), { flush: 'post' });

function onKey(e: KeyboardEvent) {
    // the pinned buttons keep their own Enter and Space
    if ((e.key === 'Escape' || !foot.value?.contains(e.target as Node)) && key(e.key)) {
        e.preventDefault();
    }
}

function run(action: () => void) {

    close(false);
    action();
}
</script>

<template>
    <!-- on phones the popover is the dimmed backdrop: a tap on it closes -->
    <div class="pp-pop" :hidden="!isOpen" @keydown="onKey" @click.self="close(false)">
        <div class="pp-panel" :class="{ few }">
            <input
                ref="search"
                v-model="query"
                class="pp-search"
                type="text"
                placeholder="Filter projects…"
                autocomplete="off"
                spellcheck="false"
                role="combobox"
                aria-label="Filter projects…"
                :aria-controls="listId"
                aria-expanded="true"
                aria-autocomplete="list"
                :aria-activedescendant="rowId(active)"
            >
            <!-- mousedown: the filter field keeps the focus -->
            <div :id="listId" ref="list" class="pp-list" role="listbox" aria-label="Project" tabindex="-1" @mousedown.prevent>
                <PickRow v-for="item in items" :key="item.value" :item />
            </div>
            <div class="pp-none" :hidden="shown.length > 0">Nothing matches</div>
            <div ref="foot" class="pp-foot">
                <button type="button" @click="run(newProject)">New project…</button>
                <button type="button" @click="run(manageProjects)">Manage projects…</button>
            </div>
        </div>
    </div>
</template>
