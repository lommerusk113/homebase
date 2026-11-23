<script setup lang="ts">
// The footer's "Token saver" switch, beside the limits strip (public/index.html #saver). On: helpers run on Sonnet.
import { provide } from 'vue';
import { TokenSaverKey } from '@/keys';
import { useTokenSaver } from '@/composables/useTokenSaver';
import SaverSwitch from './TokenSaver/SaverSwitch.vue';

provide(TokenSaverKey, useTokenSaver());
</script>

<template>
    <SaverSwitch />
</template>
