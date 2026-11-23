<script setup lang="ts">
// The "New repo" tab: name (the hint is the problem with it), description, private, and what Create will do.
import { NewProjectKey, useInjected } from '@/keys';

const { mode, name, description, priv, busy, hint, note, typed } = useInjected(NewProjectKey);
</script>

<template>
    <div class="np" id="np-new" :hidden="mode !== 'new'">
        <wa-input id="np-name" label="Name" size="s" spellcheck="false" autocapitalize="off" :value.prop="name" :hint.prop="hint" :data-invalid="hint ? '' : undefined" :disabled.prop="busy" @input="name = ($event.target as WaInput).value; typed()"></wa-input>
        <wa-textarea id="np-desc" label="Description" size="s" rows="2" resize="none" maxlength="350" :value.prop="description" :disabled.prop="busy" @input="description = ($event.target as WaTextarea).value"></wa-textarea>
        <wa-switch id="np-private" size="s" :checked.prop="priv" :disabled.prop="busy" @change="priv = ($event.target as WaSwitch).checked">Private</wa-switch>
        <p class="np-note" id="np-note">{{ note }}</p>
    </div>
</template>
