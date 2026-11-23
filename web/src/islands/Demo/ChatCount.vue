<script setup lang="ts">
import { SessionsKey, useInjected } from '@/keys';
import { Badge } from '@/components/ui/badge';

const { visible } = useInjected(SessionsKey);
</script>

<template>
    <Badge variant="secondary">{{ visible.length }} chats</Badge>
</template>
