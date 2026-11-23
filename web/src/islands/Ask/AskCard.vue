<script setup lang="ts">
// The "Claude is asking" card: the question, a permission prompt's command or diff (its first lines and "+N more
// lines"), an option per button, and the tmux command as the way out when there are no buttons (else behind a toggle).
import { computed, ref, watch } from 'vue';
import { AskKey, useInjected } from '@/keys';
import { announce } from '@/lib/page';
import CardOptions from './CardOptions.vue';
import TerminalCommand from './TerminalCommand.vue';

const DETAIL_LINES = 6;
const { card, shown, dismiss, discuss, undiscuss, discussing } = useInjected(AskKey);
const all = ref(false), terminal = ref(false);
const lines = computed(() => (card.value?.detail ? card.value.detail.split('\n') : []));
const rest = computed(() => lines.value.length - DETAIL_LINES);

watch(card, c => {
    all.value = terminal.value = false;
    if (c) {
        announce(`Claude is asking: ${c.question}`);
    }
});
</script>

<template>
    <div class="c-note c-ask" id="ask-discussing" :hidden="!shown || !discussing">
        Discussing…
        <wa-button size="s" appearance="plain" id="ask-undiscuss" @click="undiscuss">Back to the question</wa-button>
    </div>
    <div class="c-note c-ask" :class="{ risky: card?.risky }" id="ask" :hidden="!shown || discussing">
        <div class="c-ask-label">Claude is asking</div>
        <div class="c-ask-q" id="ask-q" role="heading" aria-level="3">{{ card?.question }}</div>
        <pre class="c-ask-detail mono" id="ask-detail" :hidden="!lines.length">{{ (all ? lines : lines.slice(0, DETAIL_LINES)).join('\n') }}</pre>
        <wa-button size="s" appearance="plain" class="c-ask-more" id="ask-more" :hidden="all || rest <= 0" @click="all = true">+{{ rest }} more line{{ rest === 1 ? '' : 's' }}</wa-button>
        <CardOptions id="ask-opts" :card="card" />
        <div class="c-term">
            Or type your answer below.
            <wa-button size="s" appearance="plain" id="ask-discuss" title="Talk it over in the chat before choosing" :hidden="!!card?.detail" @click="discuss">Discuss</wa-button>
            <wa-button size="s" appearance="plain" id="ask-dismiss" title="Sends Esc: Claude moves on without an answer" @click="dismiss">Decline question</wa-button>
            <wa-button size="s" appearance="plain" id="ask-term-toggle" :aria-expanded="String(terminal)" aria-controls="ask-term" :hidden="!card?.answer" @click="terminal = !terminal">Answer in a terminal</wa-button>
        </div>
        <div class="c-term" id="ask-term" :hidden="!!card?.answer && !terminal">In a terminal, run <TerminalCommand id="ask-cmd" :tmux="card?.tmux" /></div>
    </div>
</template>
