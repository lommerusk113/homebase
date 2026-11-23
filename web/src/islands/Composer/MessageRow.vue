<script setup lang="ts">
// The field row: the + menu, the message box and, on touch screens, the send button.
import { AttachmentsKey, useInjected } from '@/keys';
import PlusMenu from './PlusMenu.vue';
import MessageBox from './MessageBox.vue';

const { dropping } = useInjected(AttachmentsKey);
</script>

<template>
    <div class="c-row" :class="{ drop: dropping }">
        <PlusMenu />
        <MessageBox />
        <!-- mousedown: the tap leaves the focus in the box, so the phone's keyboard stays up -->
        <button class="c-attach c-send" id="send-btn" type="submit" aria-label="Send" @mousedown.prevent>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
    </div>
</template>
