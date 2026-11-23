<script setup lang="ts">
// The open row's detail: its MR on a phone, review comments, the agent's report (TLDR with Show more), earlier agents and edited files.
import { computed } from 'vue';
import { ItemKey, useInjected } from '@/keys';
import FoldText from '@/components/FoldText.vue';
import PrParts from './PrParts.vue';
import DetailComments from './DetailComments.vue';
import DetailActivity from './DetailActivity.vue';
import DetailFiles from './DetailFiles.vue';

const item = useInjected(ItemKey);
const nothing = computed(() => {
    const x = item.value;

    return !(x.comments?.count || x.tldr || x.body || x.activity?.length || x.files?.length);
});
</script>

<template>
    <div class="detail" @click.stop>
        <div v-if="item.pr || item.branch" class="d-mr"><PrParts /><span v-if="item.branch" class="chip mono">{{ item.branch }}</span></div>
        <DetailComments v-if="item.comments?.count" />
        <FoldText v-if="item.tldr || item.body" :tldr="item.tldr" :rest="item.body" :fold-key="`item:${item.key}`" />
        <DetailActivity v-if="item.activity?.length" />
        <DetailFiles v-if="item.files?.length" />
        <p v-if="nothing" class="muted">Nothing to show yet.</p>
    </div>
</template>
