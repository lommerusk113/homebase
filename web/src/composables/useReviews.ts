import { computed, reactive } from 'vue';
import { api, state } from 'old/core.js';
import { bindChat } from 'old/chat.js';
import { oldState } from '@/old';
import { useNotice } from '@/composables/useNotice';

const starting = reactive(new Set<string>()); // urls whose review chat is being started

/** "Review requested": open MRs by someone else that ask the user for a review, in the picked project. */
export function useReviews() {

    const { showError } = useNotice();
    const reviews = computed(() => {
        const { project, reviews = [] } = oldState.value;

        return reviews.filter(r => project === 'all' || r.project.split('/').pop() === project);
    });
    const byUrl = computed(() => new Map(reviews.value.map(r => [r.url, r])));

    /** Review: the server starts a chat in the MR's project that reviews it read-only; this opens that chat. */
    async function review(r: ReviewRequest) {

        if (starting.has(r.url)) {
            return;
        }
        starting.add(r.url);
        try {
            const res = await api('/api/reviews/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: r.url }) });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const { sessionId, tmux, dir } = await res.json();
            if (sessionId) {
                bindChat(sessionId);
            } else {
                state.startingTmux = tmux;
                state.starting = dir;
            }
        } catch (e) {
            showError((e as Error).message);
        } finally {
            starting.delete(r.url);
        }
    }

    return { reviews, byUrl, starting, review, open: (r: ReviewRequest) => window.open(r.url, '_blank', 'noopener') };
}
