<script setup lang="ts">
// "Rules changed since this chat started" above the composer; Dismiss hides it until a watched file changes again.
import { useRules } from '@/composables/useRules';

const { stale, title, load, restart, dismiss } = useRules();
</script>

<template>
    <div class="c-rules" id="rules" role="status" :hidden="!stale" :title="title">
        <span class="c-rules-text">New rules since this chat started</span>
        <span class="c-rules-acts">
            <button class="show" id="rules-load" type="button" @click="load">Load new rules</button>
            <button class="show quiet-act" id="rules-restart" type="button" title="Reloads Claude fully; interrupts running agents" @click="restart">Restart chat</button>
            <button class="c-x" id="rules-dismiss" type="button" aria-label="Dismiss" title="Dismiss" @click="dismiss">×</button>
        </span>
    </div>
</template>
