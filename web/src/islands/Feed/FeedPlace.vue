<script setup lang="ts">
// Keeps the reader's place in the feed: at the newest (end), or with the first visible bubble (key) y px below the
// feed's top. The place is taken only when the feed's offset differs from the one last taken or set (top), i.e. when
// the user scrolled, and after a click in the feed (Show more). Content that changes height by itself (a redraw, a
// thumbnail loading, a button upgrading, the composer resizing the feed) is not the reader moving: they are put back.
import { nextTick, onUnmounted, watch } from 'vue';
import { useEventListener } from '@vueuse/core';
import { FeedKey, NewMarkerKey, useInjected } from '@/keys';

const { scroller: feed } = defineProps<{ scroller: HTMLElement }>();
const { view, takeEarlier, drawn } = useInjected(FeedKey);
const marker = useInjected(NewMarkerKey);

const NEAR_BOTTOM_PX = 40; // this close to the bottom counts as reading the newest: a redraw keeps it in view
const nearBottom = () => feed.scrollHeight - feed.scrollTop - feed.clientHeight < NEAR_BOTTOM_PX;
const keyed = () => [...feed.querySelectorAll<HTMLElement>('[data-key]')];
let place: { end: boolean; top: number; key?: string; y: number } = { end: true, top: 0, y: 0 };
let height = feed.clientHeight; // the feed's own height last seen: the browser moves scrollTop when it changes
let clicked = false; // a click in the feed is being handled: a size change now is the reader's own (Show more)

function notePlace() {
    const feedTop = feed.getBoundingClientRect().top;
    // the window drops old items off the top, so the bubble is the anchor, not the scroll offset
    const b = keyed().find(b => b.getBoundingClientRect().bottom > feedTop + 5);
    place = { end: nearBottom(), top: feed.scrollTop, key: b?.dataset.key, y: b ? b.getBoundingClientRect().top - feedTop : 0 };
}
// True when the user scrolled since the place was taken; takes the new one.
function syncPlace() {
    const moved = feed.scrollTop !== place.top;
    if (moved) {
        notePlace();
    }
    return moved;
}
function restorePlace() {
    if (place.end) {
        feed.scrollTop = feed.scrollHeight;
    } else {
        feed.scrollTop = place.top;
        const b = place.key && keyed().find(b => b.dataset.key === place.key);
        if (b) {
            feed.scrollTop += b.getBoundingClientRect().top - feed.getBoundingClientRect().top - place.y;
        }
    }
    place.top = feed.scrollTop;
}
// the feed and every item in it, for a change of size, whatever the cause
const sizes = new ResizeObserver(() => {
    if (clicked) {
        return notePlace();
    }
    // the feed itself resized (keyboard, composer): the browser's scrollTop shift is not the reader moving
    if (feed.clientHeight === height) {
        syncPlace();
    }
    height = feed.clientHeight;
    restorePlace();
});
function watchSizes() {
    sizes.disconnect();
    for (const e of [feed, ...feed.children]) {
        sizes.observe(e);
    }
}

watch(view, v => {
    if (!v.chat) {
        return;
    }
    syncPlace();
    const fromBottom = takeEarlier() ? feed.scrollHeight - feed.scrollTop : null; // "Show earlier" keeps the view where it was
    nextTick(() => {
        if (fromBottom !== null) {
            feed.scrollTop = feed.scrollHeight - fromBottom;
            notePlace();
        } else {
            place.end ||= v.first || v.stick;
            restorePlace();
        }
        watchSizes();
        drawn();
    });
}, { immediate: true });

// Capture, as a Show more button stops its click; the place is taken once it has toggled, by the timeout or by the
// size watch, whichever the browser runs first.
useEventListener(feed, 'click', () => {
    clicked = true;
    setTimeout(() => {
        clicked = false;
        notePlace();
    });
}, true);
useEventListener(feed, 'scroll', () => syncPlace() && nearBottom() && marker.caughtUp());
useEventListener(window, 'blur', () => marker.leave(nearBottom()));
useEventListener(window, 'focus', marker.back);
useEventListener(document, 'visibilitychange', () => (document.hidden ? marker.leave(nearBottom()) : marker.back()));
watchSizes();
onUnmounted(() => sizes.disconnect());
</script>

<template>
    <slot />
</template>
