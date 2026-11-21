// The messages Homebase's buttons type into a chat. One table for both sides: the senders build their text here
// (canned), and the transcript parser recognises that text here (cannedLabel), so the feed shows a button's message as
// one line naming the action. Matched by text, not remembered sends: it holds after a restart and for old transcripts.
// text: what is typed, from its arguments. of: the part of the arguments the line names. arg: what an argument may
// look like, where the text is short enough that a longer typed message could otherwise pass for it.

const mr = ref => ref.replace(/ \(.*\)$/, ''); // "!12 (https://…)" -> "!12"
const issue = iid => `#${iid}`;

/** @type {Record<string, { label: string, text: (...a: any[]) => string, of?: (...a: any[]) => string, arg?: string }>} */
const CANNED = {
    rules: { label: 'Load new rules', text: files => `The rules changed. Re-read ${files} now and follow them from here on (they override your earlier instructions where they differ).` },
    continue: { label: 'Continue', text: title => `The subagent '${title}' stopped — check why and continue it.`, of: title => title },
    fix: { label: 'Fix & reply', text: ref => `Address the review comments on ${ref}, push, and reply in each thread.`, of: mr },
    pipeline: { label: 'Fix pipeline', text: ref => `The pipeline on ${ref} is failing — find out why and fix it.`, of: mr },
    rebase: { label: 'Rebase', text: ref => `Rebase ${ref} onto its target branch, resolve any conflicts and push.`, of: mr },
    ready: { label: 'Mark ready', text: ref => `Run review-gate on ${ref}. If the verdict is ready, mark it ready for review. If it's fix first, show me the findings and leave it a draft.`, of: mr },
    merge: { label: 'Merge + close issue', text: ref => `Run review-gate on ${ref}. If the verdict is ready, merge it and close its issue. If it's fix first, show me the findings and don't merge.`, of: mr },
    review: { label: 'Request review', text: ref => `Assign a reviewer to ${ref} — suggest who.`, of: mr },
    start: { label: 'Start', text: iid => `Implement #${iid}`, of: issue, arg: '\\d+' },
    close: { label: 'Close', text: (iid, mrIid) => `Close #${iid}, its MR !${mrIid} is merged`, of: issue, arg: '\\d+' },
    check: { label: 'Check on', text: (iid, mrIid) => `Check on #${iid} and !${mrIid}`, of: issue, arg: '\\d+' }
};

const named = (c, args) => [c.label, c.of?.(...args)].filter(Boolean).join(' ');

// A button's message: label is the button's own, message what it types.
/** @param {string} key @param {...any} args @returns {{ label: string, message: string }} */
export function canned(key, ...args) {
    return { label: CANNED[key].label, message: CANNED[key].text(...args) };
}

// each text with its arguments left open: nothing but the whole message matches
const SHAPES = Object.values(CANNED).map(c => /** @type {const} */ ([c, new RegExp(`^${
    c.text(...Array(c.text.length).fill('\0')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\0', `(${c.arg ?? '.+?'})`)
}$`)]));

// The feed's line for a message a button typed ("Fix & reply !12"), or null for anything else.
/** @param {string} text @returns {string | null} */
export function cannedLabel(text) {
    for (const [c, re] of SHAPES) {
        const m = text.trim().match(re);
        if (m) {
            return named(c, m.slice(1));
        }
    }
    return null;
}
