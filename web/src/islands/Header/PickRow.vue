<script setup lang="ts">
// One choice: its state dot, name, what its chats are doing, and a check on the picked one.
import { PickerKey, useInjected } from '@/keys';
import type { PickItem } from '@/composables/usePicker';

defineProps<{ item: PickItem }>();

const { value, active, shown, rowId, setActive, pick } = useInjected(PickerKey);
</script>

<template>
    <div
        :id="rowId(item.value)"
        class="pp-row"
        :class="{ act: active === item.value }"
        role="option"
        :data-value="item.value"
        :data-name="item.name"
        :data-state="item.state ?? ''"
        :aria-selected="value === item.value"
        :hidden="!shown.includes(item)"
        @mousemove="active !== item.value && setActive(item.value, false)"
        @click="pick(item.value)"
    >
        <span class="pp-dot" /><span class="pp-text"><span class="pp-name">{{ item.name }}</span><small>{{ item.sub ?? '' }}</small></span><span class="pp-check" />
    </div>
</template>
