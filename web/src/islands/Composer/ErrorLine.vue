<script setup lang="ts">
import { NoticeKey, useInjected } from '@/keys';

const { error } = useInjected(NoticeKey);
</script>

<template>
    <!-- v-text: no text node while empty, as the dock's height follows #c-err:empty (styles.css) -->
    <div class="error" id="c-err" role="alert" v-text="error"></div>
</template>
