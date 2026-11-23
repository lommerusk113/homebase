// The forge's words on the page: GitLab has MRs written !12, GitHub has PRs written #12.

/** The words from a forge's name (a session's forge, a milestone answer's) or an MR/PR URL. The one place the page picks them; unknown reads as GitLab. */
export const forgeWords = (at?: string | null) => (at === 'GitHub' || at?.includes('/pull/')
    ? { forge: 'GitHub', mr: 'PR', ref: 'PR #' }
    : { forge: 'GitLab', mr: 'MR', ref: '!' });

/** "!12" for a GitLab MR url, "#12" for a GitHub PR, "PR" for anything else. */
export const prLabel = (url: string): string => {
    const m = url.match(/merge_requests\/(\d+)/) || url.match(/pull\/(\d+)/);
    return m ? (url.includes('merge_requests') ? '!' : '#') + m[1] : 'PR';
};

/** An MR or PR page address, as a rendered link would carry it. */
export const PR_HREF = /^https:\/\/\S+?\/(?:-\/merge_requests|pull)\/\d+\/?$/;
