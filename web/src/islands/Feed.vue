<script setup lang="ts">
// The chat's message list, mounted into the old page's #feed (chat.js), which stays the scrolling element.
import { provide } from 'vue';
import { FeedKey, ImagesKey, NewMarkerKey, OutboxKey, SendKey, UnfoldKey, UnreadKey } from '@/keys';
import { useFeed } from '@/composables/useFeed';
import { useImages } from '@/composables/useImages';
import { useNewMarker } from '@/composables/useNewMarker';
import { useOutbox } from '@/composables/useOutbox';
import { useSend } from '@/composables/useSend';
import { useUnfold } from '@/composables/useUnfold';
import { useUnread } from '@/composables/useUnread';
import FeedPlace from './Feed/FeedPlace.vue';
import FeedHead from './Feed/FeedHead.vue';
import FeedItem from './Feed/FeedItem.vue';

defineProps<{ scroller: HTMLElement }>();
const feed = useFeed(), { view } = feed;

provide(FeedKey, feed);
provide(ImagesKey, useImages());
provide(NewMarkerKey, useNewMarker());
provide(OutboxKey, useOutbox());
provide(SendKey, useSend());
provide(UnfoldKey, useUnfold());
provide(UnreadKey, useUnread());
</script>

<template>
    <FeedPlace :scroller="scroller">
        <FeedHead />
        <FeedItem v-for="row in view.rows" :key="row.key" :row="row" />
        <div v-if="view.welcome" class="welcome">{{ view.welcome }}</div>
    </FeedPlace>
</template>
