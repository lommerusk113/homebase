<script setup lang="ts">
// An open card's details: the description, and "Send to chat" with the message it types (or the chat that already has it).
import { computed, useId } from 'vue';
import { IssuesKey, useInjected } from '@/keys';
import type { Card } from '@/composables/useIssues';

const props = defineProps<{ card: Card }>();

const { words, canSend, starting, workOn, showWork, send, message } = useInjected(IssuesKey);

const id = `issues-${useId()}`; // prefixed: each island is its own app, bare ids collide
const work = computed(() => workOn(props.card));
const sent = computed(() => starting(props.card));
const msg = computed(() => message(props.card));
</script>

<template>
    <div class="more" @click.stop>
        <div class="desc">{{ card.desc || 'No description.' }}</div>
        <div class="acts">
            <!-- somebody is on it already: show that chat instead of sending Implement again -->
            <template v-if="work">
                <wa-button :id class="act-btn" size="s" variant="neutral" appearance="outlined" @click.stop="showWork(work)">Check on it</wa-button>
                <wa-tooltip :for="id">Already being worked on: shows the chat that has it</wa-tooltip>
            </template>
            <template v-else>
                <wa-button :id class="act-btn" size="s" variant="brand" appearance="filled" :disabled.attr="sent || !canSend || undefined" @click.stop="send(card)">{{ sent ? 'Starting…' : 'Send to chat' }}</wa-button>
                <wa-tooltip :for="id">{{ canSend ? `Types "${msg}" into the chat on the right` : 'No chat session to send to' }}</wa-tooltip>
                <span class="msg">sends <code>{{ msg }}</code></span>
            </template>
            <a class="gl" :href="card.url" target="_blank" rel="noopener">Open in {{ words.forge }} ↗</a>
        </div>
    </div>
</template>
