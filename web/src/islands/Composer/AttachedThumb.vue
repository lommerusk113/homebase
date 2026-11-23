<script setup lang="ts">
// One attached image: its thumbnail and the × that takes it off the message.
import { ref, watchEffect } from 'vue';
import { AttachmentsKey, useInjected } from '@/keys';
import { dataUrl } from '@/lib/page';

const props = defineProps<{ file: File }>();
const { remove } = useInjected(AttachmentsKey);
const src = ref<string>();

watchEffect(() => {
    const { file } = props;
    src.value = undefined;
    dataUrl(file).then(url => {
        if (props.file === file) {
            src.value = url;
        }
    }, () => {});
});
</script>

<template>
    <span class="c-thumb"><img :alt="file.name" :src="src"><button type="button" :aria-label="`Remove ${file.name}`" @click="remove([file])">×</button></span>
</template>
