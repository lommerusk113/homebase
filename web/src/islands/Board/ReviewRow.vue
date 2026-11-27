<script setup lang="ts">
// An open MR by someone else that asks the user for a review. Click (or o) opens it at the forge.
import { toRef } from 'vue';
import { ago } from '@/lib/time';
import { ReviewsKey, useInjected } from '@/keys';
import CiPill from '@/components/CiPill.vue';

const props = defineProps<{ url: string }>();
const { byUrl, open, review, reviewing, starting, findings, sendFindings } = useInjected(ReviewsKey);
const r = toRef(() => byUrl.value.get(props.url)!);
</script>

<template>
    <tr class="rv" :data-key="`review:${url}`" :data-url="url" role="link" tabindex="0" @click="open(r)">
        <td class="what" colspan="5">
            <b>{{ r.title }}</b>
            <small class="next"><span class="chip mono">!{{ r.iid }}</span>{{ ` ${r.project} · ${r.author}${r.draft ? ' · draft' : ''} · ${ago(r.updatedAt)}` }}<template v-if="r.pipeline?.status">{{ ' ' }}<CiPill :pipeline="r.pipeline" /></template></small>
        </td>
        <td class="act">
            <small v-if="findings(r)?.kind === 'sent'" class="sent-pill" title="The findings went to the review chat to post on the MR">Findings sent</small>
            <template v-else-if="!reviewing(r) && findings(r)">
                <wa-button class="review-btn findings-btn" size="s" variant="brand" title="Types the review's findings-posting prompt into the review chat" @click.stop="sendFindings(r)">{{ findings(r)!.kind === 'approve' ? 'Approve' : 'Send findings' }}</wa-button>
                <wa-button class="review-btn" size="s" appearance="plain" title="Open the review chat to review again" @click.stop="review(r)">Re-review</wa-button>
            </template>
            <button v-else-if="reviewing(r)" type="button" class="sent-pill review-busy" title="Open the review chat" @click.stop="review(r)"><span class="pulse" />Reviewing…</button>
            <wa-button v-else class="review-btn" size="s" appearance="outlined" :disabled="starting.has(url) || undefined" title="Start a chat that reviews this MR, read-only" @click.stop="review(r)">{{ starting.has(url) ? 'Starting…' : 'Review' }}</wa-button>
        </td>
    </tr>
</template>
