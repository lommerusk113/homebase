<script setup lang="ts">
// Between the feed and the dock: the question Claude asks on its pane, a starting chat's startup question, and the info line.
import { provide } from 'vue';
import 'old/vendor/webawesome/components/button/button.js'; // defined before the first render, see Composer.vue
import { AskKey, BootKey, NoticeKey, SendKey } from '@/keys';
import { useAsk } from '@/composables/useAsk';
import { useBoot } from '@/composables/useBoot';
import { useNotice } from '@/composables/useNotice';
import { useSend } from '@/composables/useSend';
import AskCard from './Ask/AskCard.vue';
import BootCard from './Ask/BootCard.vue';
import InfoLine from './Ask/InfoLine.vue';

provide(AskKey, useAsk());
provide(BootKey, useBoot());
provide(NoticeKey, useNotice());
provide(SendKey, useSend());
</script>

<template>
    <AskCard />
    <BootCard />
    <InfoLine />
</template>
