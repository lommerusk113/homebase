<script setup lang="ts">
// Stop on a helper that runs in its own chat: closes it (asks first while it works). The tooltip says how to watch it in tmux.
import { ItemKey, useInjected } from '@/keys';
import { useHelperStop } from '@/composables/useHelperStop';

const item = useInjected(ItemKey);
const { attachHint, stop } = useHelperStop();
</script>

<template>
    <wa-button class="act-btn stop-btn" size="s" appearance="outlined" :title="attachHint(item)" @click.stop="stop(item)">Stop</wa-button>
</template>
