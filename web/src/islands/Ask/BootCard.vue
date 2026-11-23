<script setup lang="ts">
// A blocking Claude Code startup dialog (workspace trust, first run) of a chat still starting: its question, an option per button.
import { BootKey, useInjected } from '@/keys';
import CardOptions from './CardOptions.vue';
import TerminalCommand from './TerminalCommand.vue';

const { card } = useInjected(BootKey);
</script>

<template>
    <div class="c-note c-ask" id="boot" :hidden="!card">
        <div class="c-ask-label">Claude is waiting on a startup question</div>
        <div class="c-ask-q" id="boot-q" role="heading" aria-level="3">{{ card?.question }}</div>
        <CardOptions id="boot-opts" :card="card" />
        <div class="c-term">Or answer in the terminal: <TerminalCommand id="boot-cmd" :tmux="card?.tmux" /></div>
    </div>
</template>
