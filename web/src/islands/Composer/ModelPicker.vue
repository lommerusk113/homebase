<script setup lang="ts">
// The model chip: the model of the chat's latest reply; "Sonnet…" while a picked one hasn't shown up there yet.
import { ModelKey, useInjected } from '@/keys';
import { MODELS } from '@/composables/useModel';

const { shown, label, picked, locked, isCurrent, pick } = useInjected(ModelKey);
const NAMES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', default: 'Default' };

function select(e: CustomEvent<{ item: WaDropdownItem }>) {
    const { item } = e.detail;
    item.checked = !item.checked; // undo the item's own toggle: the mark follows the chat's model
    pick(item.value);
}
</script>

<template>
    <wa-dropdown class="c-model" id="c-model" placement="top-end" :hidden="!shown" @wa-select="select">
        <button class="c-chip" :class="{ pending: picked }" type="button" slot="trigger" id="c-model-btn" title="Model for this chat" aria-label="Model for this chat" :disabled="locked">{{ label }}</button>
        <wa-dropdown-item v-for="alias in MODELS" :key="alias" type="checkbox" :value.attr="alias" .checked="isCurrent(alias)">
            {{ NAMES[alias] }}<span v-if="alias === 'default'" slot="details">your account's default</span>
        </wa-dropdown-item>
    </wa-dropdown>
</template>
