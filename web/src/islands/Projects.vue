<script setup lang="ts">
// The header's ☰ button and the "Projects on your board" dialog it opens.
import { provide } from 'vue';
import 'old/vendor/webawesome/components/button/button.js';
import 'old/vendor/webawesome/components/dialog/dialog.js';
import { ProjectsKey } from '@/keys';
import { showProjects, useProjects } from '@/composables/useProjects';
import ProjectActions from './Projects/ProjectActions.vue';
import ProjectGroup from './Projects/ProjectGroup.vue';

const projects = useProjects();
const { shown, onBoard, others } = projects;

provide(ProjectsKey, projects);
</script>

<template>
    <button class="quiet" id="manage" title="Manage projects" aria-label="Manage projects" @click="showProjects">☰</button>
    <wa-dialog id="dlg" label="Projects on your board" light-dismiss :open.prop="shown" @wa-after-hide.self="shown = false">
        <div class="d-body" id="dlg-body">
            <ProjectActions />
            <ProjectGroup title="On board" :names="onBoard" kind="rm" none="None yet." />
            <ProjectGroup title="Seen in recent sessions" :names="others" kind="add" none="Nothing else found." />
        </div>
    </wa-dialog>
</template>
