<script setup lang="ts">
// The pill's menu: the chosen milestone's numbers, then "Assigned to me", every open milestone and "No milestone".
// Read-only towards GitLab/GitHub: it only links out.
import { forgeWords } from '@/lib/forge';
import { MilestoneFilterKey, useInjected } from '@/keys';
import PillGroups from './PillGroups.vue';
import PillOption from './PillOption.vue';

const { data, ms, listLoading, empty } = useInjected(MilestoneFilterKey);
</script>

<template>
    <div class="ms-menu">
        <template v-if="listLoading || !data" />
        <template v-else-if="empty">
            <div class="info">
                {{ empty.err ? `${empty.tip.replace('\n', '. ')}.` : empty.tip }}<a v-if="data.url" :href="data.url" target="_blank" rel="noopener">Milestones page ↗</a>
            </div>
            <template v-if="data.reason === 'none'"><hr><PillOption id="mine" label="Assigned to me" note="all milestones" /></template>
        </template>
        <template v-else>
            <template v-if="ms?.loading"><div class="info">Loading issues…</div><hr></template>
            <template v-else-if="ms?.error"><div class="info">Could not load the issues: {{ ms.error }}</div><hr></template>
            <PillGroups v-if="ms?.groups" />
            <!-- the open issues assigned to you in every milestone -->
            <PillOption id="mine" label="Assigned to me" note="all milestones" :on="!!ms?.mine" />
            <hr>
            <PillOption
                v-for="m in data.milestones"
                :id="String(m.id)"
                :key="m.id"
                :label="m.title"
                :note="m.total == null ? '' : `${m.closed}/${m.total}`"
                :on="ms?.id === m.id"
                :title="data.detected.includes(m.id) ? `Your ${forgeWords(data.forge).mr}s are in this milestone` : undefined"
            />
            <PillOption id="none" label="No milestone" note="show all" :on="!ms" />
        </template>
    </div>
</template>
