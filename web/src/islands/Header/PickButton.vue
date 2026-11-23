<script setup lang="ts">
// The picker's button: the picked project with its state dot, and the one cue for chats waiting in other projects.
import { computed, useTemplateRef, watch } from 'vue';
import { PickerKey, ProjectKey, useInjected } from '@/keys';

const { name, waitingElsewhere } = useInjected(ProjectKey);
const { listId, value, current, isOpen, refocused, open, toggle } = useInjected(PickerKey);
const btn = useTemplateRef('btn');

const elsewhere = computed(() => (waitingElsewhere.value ? `${waitingElsewhere.value} waiting on you in other projects` : ''));

watch(refocused, () => btn.value?.focus({ preventScroll: true }), { flush: 'post' });
</script>

<template>
    <button
        id="project"
        ref="btn"
        class="pp-btn"
        type="button"
        :value
        :data-state="current?.state ?? ''"
        :data-other="waitingElsewhere || ''"
        :aria-label="`Project: ${name}${elsewhere && `, ${elsewhere}`}`"
        :title="elsewhere || 'Switch project (g then p)'"
        aria-haspopup="listbox"
        :aria-expanded="isOpen"
        :aria-controls="listId"
        @click="toggle"
        @keydown.down.prevent="open"
        @keydown.up.prevent="open"
    >
        <span class="pp-dot" /><span class="pp-name">{{ current?.name ?? '' }}</span><span class="pp-chev" />
    </button>
</template>
