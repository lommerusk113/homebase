<script setup lang="ts">
// The "From my GitHub" tab: filter box and your repos; one already cloned offers Open, any other clones.
import { ago } from 'old/core.js';
import { NewProjectKey, useInjected } from '@/keys';

const { mode, filter, busy, repos, filtered, clone, openDir } = useInjected(NewProjectKey);
const updated = (iso: string) => { const a = ago(Date.parse(iso)); return a === 'now' ? 'updated just now' : `updated ${a} ago`; };
</script>

<template>
    <div class="np" id="np-gh" :hidden="mode !== 'gh'">
        <wa-input id="np-filter" placeholder="Filter repos" size="s" spellcheck="false" autocapitalize="off" :value.prop="filter" :disabled.prop="busy" @input="filter = ($event.target as WaInput).value"></wa-input>
        <div class="np-repos" id="np-repos">
            <div v-if="!repos" class="d-empty">Loading…</div>
            <div v-else-if="!Array.isArray(repos)" class="d-empty">{{ repos.message }}</div>
            <div v-else-if="!filtered.length" class="d-empty">No repos match.</div>
            <template v-else>
                <button v-for="r in filtered" :key="r.name" class="np-repo" type="button" :data-repo="r.name" :disabled="busy" @click="r.local ? openDir(r.dir) : clone(r.name)">
                    <b>{{ r.name }}{{ r.isPrivate ? ' · private' : '' }}<i v-if="r.local" class="np-open">Open</i></b>
                    <span>{{ r.local ? 'already cloned' : [r.description, updated(r.updatedAt)].filter(Boolean).join(' · ') }}</span>
                </button>
            </template>
        </div>
    </div>
</template>
