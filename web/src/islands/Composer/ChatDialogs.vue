<script setup lang="ts">
// The confirms before a fresh conversation, a restart and a compact. Opened on request and closed by the page (Cancel,
// Esc, the old rules strip's "Restart chat"), so their open state is the element's own, not ours.
import { watch } from 'vue';
import { ChatActionsKey, useInjected } from '@/keys';
import type { Confirm } from '@/composables/useChatActions';

const { confirming, clear, restart, compact } = useInjected(ChatActionsKey);
const DIALOGS: { what: Confirm; label: string; text: string; go: string; variant: string; run: () => void }[] = [
    { what: 'clear', label: 'Start a fresh conversation?', text: "Claude forgets this chat's context.", go: 'Start fresh', variant: 'danger', run: clear },
    { what: 'restart', label: 'Restart this chat?', text: 'Claude is stopped and started again in the same session, so a running turn is lost. The conversation history stays.', go: 'Restart', variant: 'danger', run: restart },
    { what: 'compact', label: 'Compact this conversation?', text: 'Claude summarises the chat to free up context, so each turn gets cheaper. The session stays the same.', go: 'Compact', variant: 'brand', run: compact }
];
const dialogs: Partial<Record<Confirm, WaDialog>> = {};

watch(confirming, asked => {
    if (asked && dialogs[asked.what]) {
        dialogs[asked.what]!.open = true;
    }
});

function go(d: typeof DIALOGS[number]) {
    dialogs[d.what]!.open = false;
    d.run();
}
</script>

<template>
    <wa-dialog v-for="d in DIALOGS" :key="d.what" :ref="(e: unknown) => { dialogs[d.what] = e as WaDialog; }" :id="`${d.what}-dlg`" :label="d.label">
        {{ d.text }}
        <wa-button slot="footer" size="s" appearance="outlined" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" size="s" :variant="d.variant" :id="`${d.what}-go`" :autofocus="d.what === 'compact' || undefined" @click="go(d)">{{ d.go }}</wa-button>
    </wa-dialog>
</template>
