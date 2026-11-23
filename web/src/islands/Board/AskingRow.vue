<script setup lang="ts">
// "<chat> is asking" (an AskUserQuestion or a permission prompt) or "<chat> needs you" (its idle reply wants a
// decision) atop Needs you. Click chats with it.
import { computed, toRef } from 'vue';
import { touch } from 'old/core.js';
import { excerpt } from '@/lib/text';
import { ChatRowsKey, ProjectKey, useInjected } from '@/keys';
import ChatName from './ChatName.vue';
import NeedsYou from './NeedsYou.vue';

const props = defineProps<{ sid: string }>();
const { byId, focus, replyOf, markDone, title, quietFor } = useInjected(ChatRowsKey);
const { project } = useInjected(ProjectKey);
const s = toRef(() => byId.value.get(props.sid)!);

// an idle chat with a reply for you: the title is what the reply asks, the subtitle where it comes from
const asks = computed(() => (!s.value.asking && s.value.needsText ? excerpt(s.value.needsText, 140) : null));
const since = computed(() => (quietFor(s.value) === 'now' ? 'now' : `${quietFor(s.value)} ago`));
const what = computed(() => (s.value.asking ? 'is asking' : 'needs you'));
// a phone's line is too short for the hint, and the row is plainly a button there
const hint = computed(() => `${s.value.asking ? s.value.question || 'Claude asked a question.' : 'Claude’s last reply wants your decision'}${touch() ? '' : ' · click to answer in the chat'}`);
// the row's own text as its name: the button inside is not part of it
const label = computed(() => (asks.value != null
    ? `${asks.value}${s.value.project} · ${title(s.value)} · ${since.value}`
    : `${project.value === 'all' ? `${s.value.project} · ` : ''}${title(s.value)} ${what.value}${hint.value}`));
</script>

<template>
    <tr class="asking" :data-key="`asking:${sid}`" role="button" :aria-label="label" @click="focus(sid)">
        <td class="what" colspan="6">
            <button v-if="replyOf(s)" type="button" class="need-done" title="Mark as handled" aria-label="Mark as handled" @click.stop="markDone(s)">✓</button>
            <template v-if="asks != null">
                <b><span class="pulse" />{{ ' ' }}<NeedsYou />{{ ' ' }}<bdi>{{ asks }}</bdi></b>
                <small class="next"><bdi>{{ s.project }}</bdi>{{ ' · ' }}<bdi>{{ title(s) }}</bdi>{{ ` · ${since}` }}</small>
            </template>
            <template v-else>
                <b><span class="pulse" />{{ ' ' }}<NeedsYou />{{ ' ' }}<ChatName :sid="sid" :what="what" /></b>
                <small class="next">{{ hint }}</small>
            </template>
        </td>
    </tr>
</template>
