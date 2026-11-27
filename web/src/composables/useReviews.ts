import { computed, reactive } from 'vue';
import { api, state } from 'old/core.js';
import { bindChat, sendText } from 'old/chat.js';
import { oldState } from '@/old';
import { useNotice } from '@/composables/useNotice';
import { reviewChat } from '@/lib/board';

const starting = reactive(new Set<string>()); // urls whose review chat is being started
const sentNow = reactive(new Map<string, string | null>()); // url -> head whose findings were just sent: the row says so before the server does

/** "Review requested": open MRs by someone else that ask the user for a review, in the picked project. */
export function useReviews() {

    const { showError } = useNotice();
    const reviews = computed(() => {
        const { project, reviews = [] } = oldState.value;

        return reviews.filter(r => project === 'all' || r.project.split('/').pop() === project);
    });
    /** Its review chat, or a helper that chat started, is busy: the row says Reviewing… and opens the chat. */
    const reviewing = (r: ReviewRequest) => !!reviewChat(oldState.value.sessions, r);
    /** What the row offers: the server's findings, or "sent" at once after a click (for that head only). */
    const findings = (r: ReviewRequest): ReviewFindings | null =>
        sentNow.has(r.url) && sentNow.get(r.url) === r.sha ? { kind: 'sent' } : r.findings ?? null;
    const byUrl = computed(() => new Map(reviews.value.map(r => [r.url, r])));

    /** Review: the server starts a chat in the MR's project that reviews it read-only; this opens that chat. */
    async function review(r: ReviewRequest) {

        if (starting.has(r.url)) {
            return;
        }
        const open = reviewChat(oldState.value.sessions, r);
        if (open) {
            bindChat(open.id);

            return;
        }
        starting.add(r.url);
        try {
            const res = await api('/api/reviews/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: r.url }) });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const { sessionId, tmux, dir } = await res.json();
            // the server may not match an older chat to its session (reused tmux, cleared or aged transcript): the board's poll may know it
            const id = sessionId ?? oldState.value.sessions.find(s => s.tmux === tmux)?.id;
            if (id) {
                bindChat(id);
            } else {
                state.startingTmux = tmux;
                state.starting = dir; // poll() binds it if a session shows up
                showError(`The review chat (tmux ${tmux}) is running, but Homebase cannot match it to a session yet. Click Review again in a moment.`);
            }
        } catch (e) {
            showError((e as Error).message);
        } finally {
            starting.delete(r.url);
        }
    }

    /** Send findings / Approve: types the fixed prompt into the review chat, then remembers the head as sent. Goes back on error. */
    async function sendFindings(r: ReviewRequest) {

        const f = r.findings;
        if (!f?.message || !f.sessionId || sentNow.has(r.url)) {
            return;
        }
        sentNow.set(r.url, r.sha);
        try {
            if (!await sendText(f.sessionId, f.message, undefined, undefined, true, `findings:${r.url}`)) {
                throw new Error('The review chat did not take the message');
            }
            const res = await api('/api/reviews/sent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: r.url, sha: r.sha }) });
            if (!res.ok) {
                throw new Error(await res.text());
            }
        } catch (e) {
            sentNow.delete(r.url);
            showError((e as Error).message);
        }
    }

    return { reviews, byUrl, starting, review, reviewing, findings, sendFindings, open: (r: ReviewRequest) => window.open(r.url, '_blank', 'noopener') };
}
