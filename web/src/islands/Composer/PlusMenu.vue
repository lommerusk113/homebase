<script setup lang="ts">
// The + menu: add files, and the open chat's options. "push" is app.js's (it listens on #chat).
import { useTemplateRef } from 'vue';
import { AttachmentsKey, ChatActionsKey, PushKey, useInjected } from '@/keys';

const { attach } = useInjected(AttachmentsKey);
const actions = useInjected(ChatActionsKey);
const { needsOnly, autoCompact, canCompact, hasChat } = actions;
const { label: pushLabel, state: pushState } = useInjected(PushKey);
const picker = useTemplateRef<HTMLInputElement>('picker');
const CHOICES: Record<string, () => void> = {
    view: actions.hideEarlier,
    new: () => actions.confirm('clear'),
    compact: () => actions.confirm('compact'),
    restart: () => actions.confirm('restart'),
    'auto-compact': actions.toggleAutoCompact,
    'needs-only': actions.toggleNeedsOnly
};

function select(e: CustomEvent<{ item: WaDropdownItem }>) {

    const { item } = e.detail;
    if (item.getAttribute('type') === 'checkbox') {
        item.checked = !item.checked; // undo the item's own toggle: the mark follows our state
    }
    if (item.value === 'files') {
        picker.value?.click();
    } else if (hasChat.value) {
        CHOICES[item.value]?.();
    }
}

function picked() {
    attach(picker.value?.files ?? []);
    picker.value!.value = '';
}
</script>

<template>
    <wa-dropdown class="c-plus" id="plus-menu" placement="top-start" @wa-select="select">
        <button class="c-attach" id="attach-btn" type="button" slot="trigger" aria-label="Add files and chat options" title="Add files and chat options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
        </button>
        <wa-dropdown-item value="files">Add files…</wa-dropdown-item>
        <hr class="c-sep">
        <wa-dropdown-item value="view">Hide earlier messages<small class="c-hint">only here; Claude still remembers them</small></wa-dropdown-item>
        <wa-dropdown-item value="compact" id="compact-item" .disabled="!canCompact">Compact conversation<small class="c-hint">Claude keeps a summary; frees context</small></wa-dropdown-item>
        <wa-dropdown-item value="restart" id="restart-item">Restart chat<small class="c-hint">same conversation; reloads Claude and its rules</small></wa-dropdown-item>
        <wa-dropdown-item value="new">Start a fresh conversation<small class="c-hint">Claude forgets this chat</small></wa-dropdown-item>
        <hr class="c-sep">
        <wa-dropdown-item value="auto-compact" type="checkbox" id="auto-compact" .checked="autoCompact">Auto-compact idle chats<small class="c-hint">when over 100k context</small><span slot="details" :class="{ on: autoCompact }" class="c-state">{{ autoCompact ? 'On' : 'Off' }}</span></wa-dropdown-item>
        <wa-dropdown-item value="needs-only" type="checkbox" id="needs-only" .checked="needsOnly">Show only messages that need me<span slot="details" :class="{ on: needsOnly }" class="c-state">{{ needsOnly ? 'On' : 'Off' }}</span></wa-dropdown-item>
        <wa-dropdown-item value="push" id="push-item"><span id="push-label">{{ pushLabel }}</span><span slot="details" class="c-state" id="push-state">{{ pushState }}</span></wa-dropdown-item>
    </wa-dropdown>
    <input ref="picker" type="file" id="attach-input" accept="image/*" multiple hidden @change="picked">
</template>
