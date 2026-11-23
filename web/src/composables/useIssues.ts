import { computed, reactive, ref } from 'vue';
import { forgeWords, hooks, state, visibleSessions } from 'old/core.js';
import { buildLanes, chatMessage, issueCards, type Card } from 'old/issues.js';
import { issueWork } from 'old/list.js';
import { bindChat, chatSession, sendText } from 'old/chat.js';
import { oldState } from '@/old';
import { useMilestoneFilter } from '@/composables/useMilestoneFilter';

export type { Card, Lane } from 'old/issues.js';
/** The chat (and its work item, if it has one) that already works on an issue. */
export type IssueWork = NonNullable<ReturnType<typeof issueWork>>;

const SENT_SHOWN_MS = 3000; // after a send, until the outbox or a chat's prompt names the issue: "Starting…" shows and further sends of that issue are ignored
const NO_GROUPS: IssueGroups = { closable: [], doing: [], assigned: [], unassigned: [], done: [] };

// One per page, so Esc (keys.js, through hooks.collapseIssue) folds the card the island shows.
const openIid = ref<number | null>(null);
const closedOpen = ref(false);
const sentAt = reactive(new Map<number, number>()); // iid -> last send
const clock = ref(0); // bumped when a "just sent" mark may have run out, or the outbox changed under it

hooks.collapseIssue = () => {

    const was = openIid.value != null;
    openIid.value = null;

    return was;
};

const names = (text: string | undefined, iid: number) => new RegExp(`#${iid}(?!\\d)`).test(text ?? '');

/**
 * The Issues tab: the selected milestone's open issues as cards in one lane per person, which card is open, and
 * starting an issue in the chat. Read-only towards the forge: "Send to chat" only types into the bound chat session.
 */
export function useIssues() {

    const { data, busy } = useMilestoneFilter();

    const ms = computed(() => data.value?.selected ?? null);
    /** The milestone list or the selected milestone's issues are not in yet (its counts may be). */
    const loading = computed(() => data.value === undefined || !!data.value?.loading || !!ms.value?.loading);
    const groups = computed(() => (loading.value ? NO_GROUPS : ms.value?.groups ?? NO_GROUPS));
    const lanes = computed(() => buildLanes(issueCards(groups.value), groups.value.done, data.value?.me ?? null));
    const words = computed(() => forgeWords(data.value?.forge));
    /** Whether there is a chat session to send to. */
    const canSend = computed(() => {

        void oldState.value; // chatSession reads the old state

        return !!chatSession();
    });

    /** This issue was just sent to a chat and has not landed in its transcript yet. */
    function starting(c: Card): boolean {

        void clock.value;

        return Date.now() - (sentAt.get(c.iid) ?? 0) < SENT_SHOWN_MS || oldState.value.outbox.some(o => o.canned && !o.error && names(o.text, c.iid));
    }

    /** Who already works on a not-started issue in any chat of the project, so Start never sends a second Implement. */
    function workOn(c: Card): IssueWork | null {

        void oldState.value; // visibleSessions reads the old state

        return c.st === 'todo' || c.st === 'free' ? issueWork(String(c.iid), visibleSessions().filter(s => s.project === data.value?.project)) : null;
    }

    /** Shows the chat that works on the issue, with its work item open on the Work tab. */
    function showWork(work: IssueWork) {

        state.selected = work.key ?? state.selected;
        if (work.sessionId) {
            bindChat(work.sessionId);
        }
    }

    async function send(c: Card) {

        const s = chatSession();
        if (!s || starting(c) || workOn(c)) {
            return;
        }

        sentAt.set(c.iid, Date.now());
        setTimeout(() => clock.value++, SENT_SHOWN_MS);
        if (!await sendText(s.id, chatMessage(c), undefined, undefined, true)) {
            sentAt.delete(c.iid); // refused or failed: the chat says why, and the card offers Start again
        }
        clock.value++;
    }

    function toggle(c: Card) {
        openIid.value = openIid.value === c.iid ? null : c.iid;
    }

    return { data, busy, ms, loading, groups, lanes, words, canSend, openIid, closedOpen, starting, workOn, showWork, send, toggle, message: chatMessage };
}
