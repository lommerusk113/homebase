<script setup lang="ts">
// "New project…": a fresh repo (name validated live, description, private switch), a clone of one of your GitHub repos,
// or a folder that is already there. Create, clone and open show their steps while the server works.
import { computed, provide } from 'vue';
import 'old/vendor/webawesome/components/button/button.js';
import 'old/vendor/webawesome/components/dialog/dialog.js';
import 'old/vendor/webawesome/components/input/input.js';
import 'old/vendor/webawesome/components/switch/switch.js';
import 'old/vendor/webawesome/components/textarea/textarea.js';
import { NewProjectKey } from '@/keys';
import { useNewProject } from '@/composables/useNewProject';
import NewTabs from './NewProject/NewTabs.vue';
import NewRepoForm from './NewProject/NewRepoForm.vue';
import RepoList from './NewProject/RepoList.vue';
import DirList from './NewProject/DirList.vue';
import StepList from './NewProject/StepList.vue';

const project = useNewProject();
const { shown, mode, error, canCreate, create } = project;
const label = computed(() => (mode.value === 'open' ? 'Open a project' : 'New project'));

provide(NewProjectKey, project);
</script>

<template>
    <wa-dialog id="new-dlg" :label="label" :open.prop="shown" @wa-after-hide.self="shown = false">
        <form class="np" id="np-form" autocomplete="off" @submit.prevent="canCreate && create()">
            <NewTabs />
            <NewRepoForm />
            <RepoList />
            <DirList />
            <StepList />
            <div class="error" id="np-err" role="alert">{{ error }}</div>
        </form>
        <wa-button slot="footer" size="s" appearance="outlined" data-dialog="close">Cancel</wa-button>
        <wa-button slot="footer" size="s" variant="brand" id="np-go" :hidden="mode !== 'new'" :disabled.prop="!canCreate" @click="create">Create</wa-button>
    </wa-dialog>
</template>
