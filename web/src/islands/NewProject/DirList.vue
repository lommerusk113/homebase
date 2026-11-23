<script setup lang="ts">
// The "Open folder" tab: the git repos under the base folder that have no running chat.
import { ago } from 'old/core.js';
import { NewProjectKey, useInjected } from '@/keys';

const { mode, busy, local, baseDir, openDir } = useInjected(NewProjectKey);
const used = (ms: number) => { const a = ago(ms); return a === 'now' ? 'used just now' : `used ${a} ago`; };
</script>

<template>
    <div class="np" id="np-open" :hidden="mode !== 'open'">
        <div class="np-repos" id="np-dirs">
            <div v-if="!local" class="d-empty">Loading…</div>
            <div v-else-if="!Array.isArray(local)" class="d-empty">{{ local.message }}</div>
            <div v-else-if="!local.length" class="d-empty">No git repos without a running chat in {{ baseDir }}.</div>
            <template v-else>
                <button v-for="r in local" :key="r.dir" class="np-repo" type="button" :data-dir="r.dir" :disabled="busy" @click="openDir(r.dir)">
                    <b>{{ r.name }}</b>
                    <span>{{ used(r.updated) }}</span>
                </button>
            </template>
        </div>
    </div>
</template>
