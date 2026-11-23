<script setup lang="ts">
// A fold's Show more / Show less. The click stops here, so opening a fold is not a click on what holds it.
defineProps<{ open: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
    <button class="show" :aria-expanded="open" @click.stop="$emit('toggle')">{{ open ? 'Show less' : 'Show more' }}</button>
</template>
