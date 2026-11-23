<script setup lang="ts">
import { StatusKey, useInjected } from '@/keys';

const { context, contextLevel } = useInjected(StatusKey);
</script>

<template>
    <!-- phones hide the word -->
    <span class="c-ctx" :class="contextLevel" id="status-ctx"><template v-if="context"><span class="w">context </span>{{ context }}</template></span>
</template>
