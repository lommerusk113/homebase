<script setup lang="ts">
// Puts away a row with no MR to act on (a stopped or finished helper), on every device. It comes back if that helper works again.
// A small X in the gutter left of the title; <component :is>, so Vue takes wa-button for the custom element it is.
import { ItemKey, WorkItemsKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { dismiss } = useInjected(WorkItemsKey);
</script>

<template>
    <component :is="'wa-button'" class="dismiss-btn" :size.attr="'s'" :appearance.attr="'plain'" aria-label="Dismiss" :title.attr="'Dismiss'" @click.stop="dismiss(item)">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
    </component>
</template>
