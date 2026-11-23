<script setup lang="ts">
// The header's live parts, laid out as the header's own children: the project picker, the milestone pill, and the
// update, offline and format notes. version: the server's Claude Code version warning ('' for none).
import { provide } from 'vue';
import { hooks } from 'old/core.js';
import { ConnectionKey, FormatWarnKey, MilestoneFilterKey, PickerKey, ProjectKey, UpdateKey } from '@/keys';
import { useProject } from '@/composables/useProject';
import { usePicker } from '@/composables/usePicker';
import { useMilestoneFilter } from '@/composables/useMilestoneFilter';
import { useConnection } from '@/composables/useConnection';
import { useFormatWarn } from '@/composables/useFormatWarn';
import { useUpdate } from '@/composables/useUpdate';
import ProjectPicker from './Header/ProjectPicker.vue';
import MilestonePill from './Header/MilestonePill.vue';
import UpdateNote from './Header/UpdateNote.vue';
import OfflineNote from './Header/OfflineNote.vue';
import FormatWarn from './Header/FormatWarn.vue';

const props = defineProps<{ version?: string }>();

const project = useProject();
const picker = usePicker('pp', project.items, project.project, project.setProject);
hooks.openProjects = picker.open; // keys.js: g then p

provide(ProjectKey, project);
provide(PickerKey, picker);
provide(MilestoneFilterKey, useMilestoneFilter());
provide(UpdateKey, useUpdate());
provide(ConnectionKey, useConnection());
provide(FormatWarnKey, useFormatWarn(props.version ?? ''));
</script>

<template>
    <ProjectPicker />
    <MilestonePill />
    <UpdateNote />
    <OfflineNote />
    <FormatWarn />
</template>
