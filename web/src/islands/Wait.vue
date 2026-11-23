<script setup lang="ts">
// The amber strip pinned above the composer while Claude's newest reply says something waits on the user.
import { provide } from 'vue';
import 'old/vendor/webawesome/components/button/button.js'; // defined before the first render, see Composer.vue
import { SendKey, WaitKey } from '@/keys';
import { useSend } from '@/composables/useSend';
import { useWait } from '@/composables/useWait';
import WaitStrip from './Wait/WaitStrip.vue';

provide(SendKey, useSend());
provide(WaitKey, useWait());
</script>

<template>
    <WaitStrip />
</template>
