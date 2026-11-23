<script setup lang="ts">
// The board: work items grouped by what they wait on, the chats' own rows and review requests. Mounted once into
// #masters by renderBoard() (public/list.js); every redraw of the old page is a bump it follows.
import { onBeforeUpdate, onMounted, onUpdated, provide, watchEffect } from 'vue';
import { hooks, setWorkCount } from 'old/core.js';
import { BoardGroupsKey, ChatRowsKey, CommentsKey, FoldsKey, ForgeNotesKey, ProjectKey, ReviewsKey, SelectionKey, SentMarksKey, WorkItemsKey } from '@/keys';
import { useProject } from '@/composables/useProject';
import { useSentMarks } from '@/composables/useSentMarks';
import { useWorkItems } from '@/composables/useWorkItems';
import { useSelection } from '@/composables/useSelection';
import { useComments } from '@/composables/useComments';
import { useChatRows } from '@/composables/useChatRows';
import { useReviews } from '@/composables/useReviews';
import { useFolds } from '@/composables/useFolds';
import { useForgeNotes } from '@/composables/useForgeNotes';
import { useBoardGroups } from '@/composables/useBoardGroups';
import Welcome from './Board/Welcome.vue';
import ForgeNotes from './Board/ForgeNotes.vue';
import OpenGroup from './Board/OpenGroup.vue';
import FoldGroup from './Board/FoldGroup.vue';
import ReviewGroup from './Board/ReviewGroup.vue';

const marks = useSentMarks(), work = useWorkItems(marks), chats = useChatRows(), reviews = useReviews(), folds = useFolds();
const { hasProjects, groups, empty, needsCount } = provideAll();

function provideAll() {

    const board = useBoardGroups(work, chats, reviews, folds);
    provide(ProjectKey, useProject());
    provide(SentMarksKey, marks);
    provide(WorkItemsKey, work);
    provide(SelectionKey, useSelection());
    provide(CommentsKey, useComments());
    provide(ChatRowsKey, chats);
    provide(ReviewsKey, reviews);
    provide(FoldsKey, folds);
    provide(ForgeNotesKey, useForgeNotes());
    provide(BoardGroupsKey, board);

    return board;
}

// the Work count in the board's title and on the phone's Work button
watchEffect(() => setWorkCount(needsCount.value));

// keys.js keeps the rows focusable (roving tabindex, ARIA state) after each draw, and puts focus back on the row it
// tracks when the draw took that row's element away
const pane = () => document.getElementById('masters');
let hadFocus = false;
const drawn = () => hooks.rendered?.(hadFocus && !pane()?.contains(document.activeElement));
onBeforeUpdate(() => { hadFocus = !!pane()?.contains(document.activeElement); });
onMounted(drawn);
onUpdated(drawn);
</script>

<template>
    <Welcome v-if="!hasProjects" />
    <template v-else>
        <ForgeNotes />
        <div v-if="empty" :class="empty.cls">{{ empty.text }}</div>
        <template v-for="g in groups" :key="g.key">
            <ReviewGroup v-if="g.key === 'reviews'" />
            <FoldGroup v-else-if="g.fold" :column="g.key" />
            <OpenGroup v-else :column="g.key" />
        </template>
    </template>
</template>

<style>
/* The board keeps styles.css's look, which counts on the browser's own margins and paddings (a report's paragraphs
   and lists, the detail's headings): the islands' reset is taken back here. */
@layer base {
    #masters.hb-island :where(*, ::before, ::after) {
        border: revert-layer;
        margin: revert-layer;
        padding: revert-layer;
    }
    #masters.hb-island :where(button) {
        font: revert-layer;
        color: revert-layer;
        background: revert-layer;
        cursor: revert-layer;
    }
}
</style>
