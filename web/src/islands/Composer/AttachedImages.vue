<script setup lang="ts">
import { AttachmentsKey, useInjected } from '@/keys';
import AttachedThumb from './AttachedThumb.vue';

const { attached } = useInjected(AttachmentsKey);
</script>

<template>
    <div class="c-attached" id="attached" :hidden="!attached.length">
        <AttachedThumb v-for="(file, n) in attached" :key="n" :file="file" />
    </div>
</template>
