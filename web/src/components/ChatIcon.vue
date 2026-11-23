<script setup lang="ts">
// The small chat icon on a board row that has a conversation behind it; the row decides what opening it does.
// <component :is>, so Vue takes wa-button for the custom element it is; .attr, as DiffIcon does.
</script>

<template>
    <component :is="'wa-button'" class="step-in" :size.attr="'s'" :appearance.attr="'plain'" aria-label="Open chat" :title.attr="'Open chat'" @click.stop>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
    </component>
</template>
