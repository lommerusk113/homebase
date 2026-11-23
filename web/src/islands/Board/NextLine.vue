<script setup lang="ts">
// "Next: <step>" under the title. A running agent's line says what it does now, and how long it has been on that
// step once that's a minute or more. The badge and the hint come first, so the ellipsis doesn't cut them.
import { ago } from 'old/core.js';
import { CommentsKey, ItemKey, SentMarksKey, useInjected } from '@/keys';
import CommentBadge from './CommentBadge.vue';

const item = useInjected(ItemKey);
const { fresh } = useInjected(CommentsKey);
const { noReply } = useInjected(SentMarksKey);

function text(x: WorkItem) {

    const live = x.agentStatus === 'running' && x.column === 'doing', stepFor = live && x.stepAt ? ago(x.stepAt) : 'now';
    const n = fresh(x).length;

    return `${live ? 'Now' : 'Next'}: ${x.next}${stepFor === 'now' ? '' : ` · for ${stepFor}`}${n ? ` · ${n} new comment${n === 1 ? '' : 's'}` : ''}`;
}
</script>

<template>
    <small class="next"><template v-if="item.comments?.count"><CommentBadge />{{ ' ' }}</template><span v-if="noReply(item)" class="no-reply">{{ 'No response yet — check the chat · ' }}</span>{{ text(item) }}</small>
</template>
