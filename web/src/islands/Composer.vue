<script setup lang="ts">
// The chat's dock: the error line, the status line, the attached images and the message box, plus the dialogs its menu opens.
import { provide } from 'vue';
// the Web Awesome elements drawn here, defined before the first render (the page's loader would fetch them only after it)
import 'old/vendor/webawesome/components/textarea/textarea.js';
import 'old/vendor/webawesome/components/dropdown/dropdown.js';
import 'old/vendor/webawesome/components/dropdown-item/dropdown-item.js';
import 'old/vendor/webawesome/components/dialog/dialog.js';
import 'old/vendor/webawesome/components/button/button.js';
import { AttachmentsKey, ChatActionsKey, ComposerKey, ModelKey, NoticeKey, PushKey, StatusKey } from '@/keys';
import { useComposer } from '@/composables/useComposer';
import { useAttachments } from '@/composables/useAttachments';
import { useNotice } from '@/composables/useNotice';
import { useStatus } from '@/composables/useStatus';
import { useModel } from '@/composables/useModel';
import { useChatActions } from '@/composables/useChatActions';
import { usePush } from '@/composables/usePush';
import ErrorLine from './Composer/ErrorLine.vue';
import StatusLine from './Composer/StatusLine.vue';
import AttachedImages from './Composer/AttachedImages.vue';
import MessageRow from './Composer/MessageRow.vue';
import ChatDialogs from './Composer/ChatDialogs.vue';

const composer = useComposer(), attachments = useAttachments();
provide(ComposerKey, composer);
provide(AttachmentsKey, attachments);
provide(NoticeKey, useNotice());
provide(StatusKey, useStatus());
provide(ModelKey, useModel());
provide(ChatActionsKey, useChatActions());
provide(PushKey, usePush());

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

function over(e: DragEvent) {
    if (hasFiles(e)) {
        e.preventDefault();
        attachments.dropping.value = true;
    }
}

function drop(e: DragEvent) {
    attachments.dropping.value = false;
    if (hasFiles(e)) {
        e.preventDefault();
        attachments.attach(e.dataTransfer?.files ?? []);
    }
}
</script>

<template>
    <form class="c-input" id="send" @submit.prevent="composer.submit" @dragover="over" @dragleave="attachments.dropping.value = false" @drop="drop">
        <ErrorLine />
        <div class="composer">
            <StatusLine />
            <AttachedImages />
            <MessageRow />
        </div>
    </form>
    <ChatDialogs />
</template>
