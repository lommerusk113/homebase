<script setup lang="ts">
// A sent message's images as thumbnails. Click one: the full image over the page; a click or Escape closes it.
import { ref, watchEffect } from 'vue';
import { useEventListener } from '@vueuse/core';
import { ImagesKey, useInjected } from '@/keys';

const props = defineProps<{ names: string[] }>();
const images = useInjected(ImagesKey);
const urls = ref<Record<string, string>>({}); // by name, once loaded; '' for one that can't be read, which then shows nothing
const zoomed = ref<string | null>(null);

watchEffect(() => {
    for (const name of props.names) {
        images.url(name).then(u => { urls.value[name] = u; });
    }
});
useEventListener(document, 'keydown', e => {
    if (e.key === 'Escape') {
        zoomed.value = null;
    }
});
</script>

<template>
    <div class="b-images">
        <template v-for="name in names" :key="name">
            <img v-if="urls[name] !== ''" :src="urls[name]" :alt="name" @click="zoomed = name">
        </template>
    </div>
    <Teleport to="body">
        <div v-if="zoomed" class="lightbox" @click="zoomed = null"><img :src="urls[zoomed]" :alt="zoomed"></div>
    </Teleport>
</template>
