<script setup lang="ts">
import { NoticeKey, useInjected } from '@/keys';

const { info } = useInjected(NoticeKey);
</script>

<template>
    <div class="c-info" id="c-info" role="status" v-text="info"></div>
</template>
