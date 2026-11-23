<script setup lang="ts">
// One open issue: its state, title and MRs; a click (or Enter, keys.js) opens it to the description and "Send to chat".
import { computed } from 'vue';
import { ago } from 'old/core.js';
import { STATES, shortTitle } from 'old/issues.js';
import { cannedLabel } from 'old/canned.js';
import { IssuesKey, useInjected } from '@/keys';
import type { Card } from '@/composables/useIssues';
import MrChip from './MrChip.vue';
import IssueStart from './IssueStart.vue';
import IssueMore from './IssueMore.vue';

const props = defineProps<{ card: Card }>();

const { ms, words, openIid, starting, workOn, toggle, message } = useInjected(IssuesKey);

const open = computed(() => openIid.value === props.card.iid);
const work = computed(() => workOn(props.card));
// what the a key confirms and sends, through the card's .act-btn; nothing when a chat already works on it
const msg = computed(() => (work.value ? undefined : message(props.card)));
const state = computed(() => (work.value ? STATES.doing : starting(props.card) ? 'starting…' : STATES[props.card.st]));
</script>

<template>
    <article
        class="card"
        :class="[card.st, { open }]"
        :data-key="`issue:${card.iid}`"
        :data-url="card.url"
        :data-msg="msg"
        :data-label="msg && cannedLabel(msg)"
        :aria-expanded="open"
        :title="open ? undefined : card.title"
        @click="toggle(card)"
    >
        <div class="top">
            <span class="mono">#{{ card.iid }}</span><span class="st">{{ state }}</span><span class="age" :title="card.updated ? `Updated ${new Date(card.updated).toLocaleString()}` : undefined">{{ card.updated ? ago(Date.parse(card.updated)) : '' }}</span>
        </div>
        <div class="tt">{{ open ? card.title : shortTitle(card.title, ms?.title ?? '') }}</div>
        <small v-if="ms?.mine && card.milestoneTitle" class="is-ms">⚑ {{ card.milestoneTitle }}</small>
        <div class="ft">
            <MrChip v-for="mr in card.mrs" :key="mr.iid" :mr />
            <span v-if="!card.mrs.length" class="chip">no {{ words.mr }}</span>
            <IssueStart v-if="!open && (card.st === 'todo' || card.st === 'free')" :card />
        </div>
        <IssueMore v-if="open" :card />
    </article>
</template>
