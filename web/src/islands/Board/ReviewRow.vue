<script setup lang="ts">
// An open MR by someone else that asks the user for a review. Click (or o) opens it at the forge.
import { toRef } from 'vue';
import { ago } from '@/lib/time';
import { ReviewsKey, useInjected } from '@/keys';
import CiPill from '@/components/CiPill.vue';

const props = defineProps<{ url: string }>();
const { byUrl, open } = useInjected(ReviewsKey);
const r = toRef(() => byUrl.value.get(props.url)!);
</script>

<template>
    <tr class="rv" :data-key="`review:${url}`" :data-url="url" role="link" tabindex="0" @click="open(r)">
        <td class="what" colspan="6">
            <b>{{ r.title }}</b>
            <small class="next"><span class="chip mono">!{{ r.iid }}</span>{{ ` ${r.project} · ${r.author}${r.draft ? ' · draft' : ''} · ${ago(r.updatedAt)}` }}<template v-if="r.pipeline?.status">{{ ' ' }}<CiPill :pipeline="r.pipeline" /></template></small>
        </td>
    </tr>
</template>
