<script setup lang="ts">
// One person's lane: who, what they have open, and their cards. The last lane is Unassigned (who: null).
import { computed } from 'vue';
import { firstName } from '@/lib/comments';
import { IssuesKey, useInjected } from '@/keys';
import type { Lane } from '@/composables/useIssues';
import IssueCard from './IssueCard.vue';

const props = defineProps<{ lane: Lane, n: number }>();

const { ms } = useInjected(IssuesKey);

const COLOURS = ['#0969da', '#8250df', '#1a7f37', '#9a6700', '#bf3989', '#0a7b83'];
const COUNTED = [['doing', 'in progress'], ['closable', 'can close'], ['todo', 'not started'], ['free', 'unassigned']];
const initials = (name: string) => name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

const open = computed(() => {

    const { who, list } = props.lane;
    const count = (st: string) => list.filter(c => c.st === st).length;
    const parts = who ? COUNTED.filter(([st]) => count(st)).map(([st, label]) => `${count(st)} ${label}`) : list.length ? [`${list.length} up for grabs`] : [];

    return parts.join(' · ') || 'nothing open';
});
</script>

<template>
    <!-- Unassigned is amber only while something is up for grabs -->
    <section class="lane" :class="{ free: !lane.who && lane.list.length }">
        <div class="who">
            <div class="name" :title="lane.who ? `${lane.who.name} (@${lane.who.username})` : undefined">
                <span class="av" :class="{ none: !lane.who }" :style="lane.who ? { background: COLOURS[n % COLOURS.length] } : undefined">{{ lane.who ? initials(lane.who.name) : '?' }}</span>{{ lane.who ? firstName(lane.who.name) : 'Unassigned' }}<span v-if="lane.me" class="you">you</span>
            </div>
            <small>{{ open }}</small>
            <small>{{ lane.closed }} closed</small>
        </div>
        <div class="strip">
            <IssueCard v-for="card in lane.list" :key="card.iid" :card />
            <span v-if="!lane.list.length" class="empty">{{ ms?.total === 0 ? 'No issues here.' : 'Every open issue has an owner.' }}</span>
        </div>
    </section>
</template>
