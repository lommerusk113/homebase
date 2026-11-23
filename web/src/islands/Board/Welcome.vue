<script setup lang="ts">
// No project is followed yet: the button opens the old page's project manager.
const manage = () => document.getElementById('manage')?.click();
</script>

<template>
    <div class="welcome">
        <h2>No projects on your board</h2>
        <div>Pick the projects you want to follow. Sessions from other projects stay hidden.</div>
        <wa-button size="m" appearance="accent" variant="success" @click="manage">+ Add projects</wa-button>
    </div>
</template>
