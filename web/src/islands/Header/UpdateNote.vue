<script setup lang="ts">
// "Homebase was updated — Reload server" / "Page updated — Refresh"; phones show only the button (styles.css).
import { UpdateKey, useInjected } from '@/keys';

const { shown, reloading, text, action, apply } = useInjected(UpdateKey);
</script>

<template>
    <span id="updated" class="updated" role="status" :hidden="!shown"><span id="updated-text">{{ text }}</span> <button id="updated-go" class="show" type="button" :hidden="reloading" @click="apply">{{ action }}</button></span>
</template>
