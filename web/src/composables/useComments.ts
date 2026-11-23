import { freshComments, seenAt, markSeen, authorSummary, updateTitle } from 'old/core.js';
import { renderBoard } from 'old/list.js';
import { oldState } from '@/old';

/** Review comments on the rows' MRs: which are new since the user last looked, and marking them seen. */
export function useComments() {

    const fresh = (x: WorkItem): ReviewComment[] => (x.pr ? freshComments(x.comments, seenAt(x.pr)) : []);
    // in an open detail: what was new when it was opened (opening marks the MR seen)
    const freshInDetail = (x: WorkItem): ReviewComment[] => {
        const opened = oldState.value.opened;

        return freshComments(x.comments, opened?.key === x.key ? opened.since : seenAt(x.pr ?? ''));
    };
    const every = (x: WorkItem): ReviewComment[] => freshComments(x.comments, 0);

    function markAllSeen() {

        for (const x of oldState.value.sessions.flatMap(s => s.items || [])) {
            if (x.pr) {
                markSeen(x.pr);
            }
        }
        renderBoard();
        updateTitle();
    }

    return { fresh, freshInDetail, every, authors: authorSummary, markAllSeen };
}
