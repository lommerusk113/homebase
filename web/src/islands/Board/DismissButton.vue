<script setup lang="ts">
// Puts away a row with no MR to act on (a stopped or finished helper), on every device. It comes back if that helper works again.
import { ItemKey, WorkItemsKey, useInjected } from '@/keys';

const item = useInjected(ItemKey);
const { dismiss } = useInjected(WorkItemsKey);
</script>

<template>
    <wa-button class="dismiss-btn" size="s" appearance="plain" title="Hide this row. It comes back if its helper starts working again." @click.stop="dismiss(item)">Dismiss</wa-button>
</template>
