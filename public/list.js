// Left column: work items grouped by what they wait on, and attention transitions.
import { $, el, COLUMNS, COL, LIFECYCLE, state, store, hooks, visibleSessions, ago, prChip, plain, foldable, waButton, tooltip, seenAt, markSeen, freshComments, authorSummary, updateTitle, setWorkCount, waitsOnYou } from './core.js';
import { chatSession, bindChat, focusChat, sendText, isMaster } from './chat.js';
import { milestoneTag } from './milestone.js';
import { diffIcon } from './diff.js';


/** @param {Column} key */
const dot = key => {
    const d = el('span', 'dot' + (key === 'doing' ? ' live' : ''));
    d.style.setProperty('--c', `var(${COL[key].color})`);
    return d;
};

// CI pill next to the MR chip: ✓ passed, ✗ failed, ● running/pending, grey for the rest; nothing without a pipeline.
const PIPE = { success: ['✓', 'passed'], failed: ['✗', 'failed'], running: ['●', 'running'], pending: ['●', 'pending'], created: ['●', 'pending'], preparing: ['●', 'pending'], waiting_for_resource: ['●', 'pending'], scheduled: ['●', 'scheduled'] };
/** @param {Pipeline | null | undefined} p @returns {HTMLElement[]} */
export function ciPill(p) {
    if (!p?.status) {
        return [];
    }
    const [icon, word] = PIPE[p.status] ?? ['–', p.status.replace(/_/g, ' ')];
    const a = el(p.url ? 'a' : 'span', `ci-pill ci-${p.status}`, icon);
    if (a instanceof HTMLAnchorElement) {
        a.href = p.url;
        a.target = '_blank';
        a.onclick = e => e.stopPropagation();
    }
    const when = p.at && ago(Date.parse(p.at));
    a.setAttribute('aria-label', `Pipeline ${word}`);
    return [a, tooltip(a, `Pipeline ${word}${when ? ` · ${when === 'now' ? 'just now' : `${when} ago`}` : ''}`)];
}

// review-gate badge next to the MR chip: ✓ gate (ready), ⚠ gate (fix first), gate stale once the MR head moved; nothing if it never ran.
/** @param {Gate | null} g @returns {HTMLElement[]} */
function gateBadge(g) {
    if (!g) {
        return [];
    }
    const [cls, label] = g.stale ? ['stale', 'gate stale'] : g.verdict === 'ready' ? ['ready', '✓ gate'] : ['fix', '⚠ gate'];
    const b = el('span', `gate-badge gate-${cls}`, label);
    const when = g.at && ago(g.at);
    const tip = [`review-gate: ${g.verdict}${g.stale ? ' (MR changed since)' : ''}`, when && (when === 'now' ? 'just now' : `${when} ago`), plain(g.tldr)].filter(Boolean).join(' · ');
    b.setAttribute('aria-label', tip);
    return [b, tooltip(b, tip)];
}

// What the session is on: its newest reply's topic, else the start of its last prompt.
/** @param {Pick<Session, 'topic' | 'lastPrompt'>} s */
export function sessionTopic(s) {
    if (s.topic) {
        return s.topic;
    }
    return excerpt(s.lastPrompt) || 'No prompt yet';
}
// plain() would also drop the # of "#2225"; only markdown emphasis and leading heading marks go here
const excerpt = (t, n = 80) => {
    const p = (t || '').replace(/[*_`>]+|^\s*#+\s+/g, '').replace(/\s+/g, ' ').trim();
    return p.length > n ? p.slice(0, n).replace(/\s+\S*$/, '') + '…' : p;
};
// Issues (#N) the session's running or queued prompts name that no work item covers yet: placeholder rows in Doing.
/** @param {Session} s @param {WorkItem[]} items the project's items @returns {string[]} */
export function startingIssues(s, items) {
    const asked = [s.status === 'working' ? s.now : null, ...(s.queued ?? [])].flatMap(t => [...(t ?? '').matchAll(/(?<![\w&!#])#(\d+)\b/g)].map(m => m[1]));
    const covered = n => items.some(x => String(x.prState?.issue ?? '') === n || new RegExp(`#${n}(?!\\d)`).test(x.title ?? '') || x.branch?.startsWith(`${n}-`));
    return [...new Set(asked)].filter(n => !covered(n));
}
// "#2225 · starting…": the master took the issue on, but no subagent or MR shows it yet. Click chats with that session.
/** @param {Session} s @param {string} n */
function starting(s, n) {
    const tr = el('tr', 'starting'), what = el('td', 'what'), b = el('b');
    tr.dataset.key = `starting:${s.id}:${n}`;
    b.append(el('span', 'pulse'), ` #${n} · starting…`);
    what.append(b, el('small', 'next', s.status === 'working' && s.now?.includes(`#${n}`) ? 'The chat session is on it' : 'Queued in the chat session'));
    what.colSpan = 6;
    tr.append(what);
    tr.onclick = () => bindChat(s.id);
    return tr;
}

// "project · Now: <step> · for 2m" for a working main chat; the time is since its newest tool call, else its turn start.
/** @param {Session} s */
export function workingLine(s) {
    const t = ago(s.stepAt ?? s.since ?? s.lastActivity ?? s.updated);
    return `${s.project} · Now: ${s.step || 'thinking'}${t === 'now' ? '' : ` · for ${t}`}`;
}
// What a working chat is on: the request its turn handles (no pasted image paths), else its newest reply's topic, else its title.
/** @param {Session} s */
export function workingTitle(s) {
    return excerpt((s.now ?? '').replace(/\[Image: [^\]]*\]/g, ''), 100) || s.topic || s.title || sessionTopic(s);
}
// The project's main chat while it works: "<request>" with "project · Now: <step> · for 2m". Click chats with it. Leaves with the status.
/** @param {Session} s */
function workingRow(s) {
    const tr = el('tr', 'starting working'), what = el('td', 'what'), b = el('b');
    tr.dataset.key = `working:${s.id}`;
    tr.setAttribute('role', 'button');
    b.append(el('span', 'pulse'), ` ${workingTitle(s)} `, el('span', 'chip', 'main chat'));
    what.append(b, el('small', 'next', workingLine(s)));
    what.colSpan = 6;
    tr.append(what);
    tr.onclick = () => focusChat(s.id);
    return tr;
}

// "<chat> is asking" (an AskUserQuestion or a permission prompt) or "<chat> needs you" (its idle reply wants a decision) atop Needs you. Click chats with it.
/** @param {Session} s */
function askingRow(s) {
    const tr = el('tr', 'asking'), what = el('td', 'what'), b = el('b');
    tr.dataset.key = `asking:${s.id}`;
    tr.setAttribute('role', 'button');
    // an idle chat with a reply for you: the title is what the reply asks, the subtitle where it comes from
    if (!s.asking && s.needsText) {
        const since = ago(s.lastActivity ?? s.updated);
        b.append(el('span', 'pulse'), ` ${excerpt(s.needsText, 140)}`);
        what.append(b, el('small', 'next', [s.project, s.title || sessionTopic(s), since === 'now' ? 'now' : `${since} ago`].join(' · ')));
    } else {
        b.append(el('span', 'pulse'), ` ${state.project === 'all' ? `${s.project} · ` : ''}${s.title || sessionTopic(s)} ${s.asking ? 'is asking' : 'needs you'}`);
        what.append(b, el('small', 'next', `${s.asking ? s.question || 'Claude asked a question.' : 'Claude’s last reply wants your decision'} · click to answer in the chat`));
    }
    what.colSpan = 6;
    tr.append(what);
    tr.onclick = () => focusChat(s.id);
    return tr;
}

// "Review requested": an open MR by someone else that asks me for a review. Click opens it in GitLab.
/** @param {ReviewRequest} r */
function reviewRow(r) {
    const tr = el('tr', 'rv'), what = el('td', 'what'), b = el('b', null, r.title), tag = el('span', 'chip mono', `!${r.iid}`);
    tr.dataset.key = `review:${r.url}`;
    tr.setAttribute('role', 'link');
    tr.tabIndex = 0;
    what.colSpan = 6;
    what.append(b, el('small', 'next', ''));
    what.lastElementChild.append(tag, ` ${r.project} · ${r.author}${r.draft ? ' · draft' : ''} · ${ago(r.updatedAt)}`, ...ciPill(r.pipeline).map(n => (n instanceof HTMLElement ? [' ', n] : [n])).flat());
    tr.append(what);
    tr.dataset.url = r.url;
    tr.onclick = () => window.open(r.url, '_blank', 'noopener');
    return tr;
}

// One work item's row, plus its detail row while selected.
/** @param {WorkItem} x @returns {HTMLElement[]} */
function itemRows(x) {
    const tr = el('tr', state.selected === x.key ? 'sel' : '');
    tr.dataset.key = x.key;
    const what = el('td', 'what');
    const fresh = x.pr ? freshComments(x.comments, seenAt(x.pr)) : [];
    // a running agent's line says what it does now, and how long it has been on that step once that's a minute or more
    const live = x.agentStatus === 'running' && x.column === 'doing', stepFor = live && x.stepAt ? ago(x.stepAt) : 'now';
    const next = el('small', 'next', `${live ? 'Now' : 'Next'}: ${x.next}${stepFor === 'now' ? '' : ` · for ${stepFor}`}${fresh.length ? ` · ${fresh.length} new comment${fresh.length === 1 ? '' : 's'}` : ''}`);
    // before Next, so the ellipsis doesn't cut it
    if (unanswered.get(x.key) === x.action?.label && x.action && !x.sent && !x.requested) {
        next.prepend(el('span', 'no-reply', 'No response yet — check the chat · '));
    }
    if (x.comments?.count) {
        next.prepend(commentBadge(x, fresh), ' ');
    }
    const name = el('b', null, x.title);
    if (x.firstTitle) {
        name.title = `Started as: ${x.firstTitle}`;
    }
    what.append(name, next);
    // with a milestone picked every row is in it, so the tag would only repeat the header pill
    if (x.milestone && !hooks.milestoneId()) {
        what.firstElementChild.prepend(milestoneTag(x));
    }
    if (state.project === 'all') {
        what.firstElementChild.prepend(el('span', 's-proj', x.project), ' ');
    }
    const prog = el('td', 'prog');
    prog.append(stageBar(x));
    if (x.tokens || x.time) {
        const m = el('small', 'meta', [x.tokens, x.time].filter(Boolean).join(' · '));
        prog.append(m);
        if (x.tokensTitle) {
            prog.append(tooltip(m, x.tokensTitle));
        }
    }
    const pr = el('td', 'pr');
    pr.append(...prParts(x));
    const br = el('td', 'br');
    if (x.branch) {
        br.append(el('span', 'chip mono', x.branch));
    }
    const act = el('td', 'act');
    act.append(...diffIcon(x, renderBoard));
    if (x.sent || x.requested) {
        act.append(sentPill(x));
    } else if (x.action && x.sessionId) {
        act.append(...actionButton(x));
    }
    tr.append(what, prog, pr, br, act, el('td', 'when', x.updated ? ago(x.updated) : ''));
    tr.onclick = () => select(x);
    if (state.selected !== x.key) {
        return [tr];
    }
    const more = el('tr', 'detail'), td = el('td');
    td.colSpan = 6;
    td.append(detail(x));
    more.append(td);
    return [tr, more];
}

// MR chip, CI pill, gate badge and the out-of-date warning: the row's MR cell, and on a phone (where that cell is hidden) the top of the detail.
/** @param {WorkItem} x @returns {Node[]} */
function prParts(x) {
    if (!x.pr) {
        return [];
    }
    const out = [prChip(x), ...ciPill(x.prState?.pipeline), ...gateBadge(x.gate)];
    // the lookup failed but an older answer is shown: say it may be out of date (with no answer, Next already says so)
    if (x.forgeError && x.prState) {
        const w = el('span', 'ci-pill stale', '⚠');
        w.tabIndex = 0;
        w.setAttribute('aria-label', 'May be out of date');
        out.push(w, tooltip(w, `Couldn't check this MR just now (${x.forgeError}), so this is what it was last time`));
    }
    return out;
}

/** @param {WorkItem[]} list */
function itemTable(list) {
    const t = el('table', 'rows');
    t.setAttribute('role', 'grid');
    t.append(...list.flatMap(x => itemRows(x)));
    return t;
}

// "all waiting on Ann" when every row's next step is the same "Waiting for review by Ann", else ''.
/** @param {WorkItem[]} list */
export function reviewNote(list) {
    const m = list[0]?.next?.match(/^Waiting for review by (.+)$/);

    return m && list.every(x => x.next === list[0].next) ? `all waiting on ${m[1]}` : '';
}

// Folded groups: Merged stays open for this page load once opened; Recently finished and In review remember per project, after a toggle.
// note: a muted summary beside the count while folded.
/** @param {typeof COLUMNS[number]} c @param {WorkItem[]} list @param {boolean} isOpen @param {(open: boolean) => void} setOpen @param {string} [note] */
function foldGroup(c, list, isOpen, setOpen, note) {
    const f = el('wa-details', `group g-${c.key}`), sum = el('span', 'g-head');
    f.setAttribute('appearance', 'plain');
    f.toggleAttribute('open', isOpen);
    sum.slot = 'summary';
    sum.append(dot(c.key), `${c.label} (${list.length})`);
    if (note) {
        sum.append(el('span', 'g-note', ` · ${note}`));
    }
    // tooltips inside also fire wa-show/wa-hide, and those bubble
    f.addEventListener('wa-show', e => {
        if (e.target === f) {
            setOpen(true);
        }
    });
    f.addEventListener('wa-hide', e => {
        if (e.target === f) {
            setOpen(false);
        }
    });
    f.append(sum, itemTable(list));
    return f;
}

// Work items (one per MR, plus running/stopped agents without one), grouped by what they wait on; recently finished and merged ones folded at the bottom.
function renderItems() {
    const items = visibleSessions().flatMap(s => s.items || []).filter(x => hooks.inMilestone(x)).map(x => optimistic(x)).sort((a, b) => b.updated - a.updated);
    const placeholders = visibleSessions().filter(isMaster).flatMap(s => startingIssues(s, visibleSessions().filter(o => o.project === s.project).flatMap(o => o.items || [])).map(n => starting(s, n)));
    const asking = visibleSessions().filter(waitsOnYou).map(askingRow);
    // one row per session: a "starting #N" placeholder already stands for a working chat
    const covered = new Set(placeholders.map(r => r.dataset.key.split(':')[1]));
    const working = visibleSessions().filter(s => isMaster(s) && s.status === 'working' && !waitsOnYou(s) && !covered.has(s.id)).map(workingRow);
    const finishedKey = `fold:finished:${state.project}`, reviewKey = `fold:review:${state.project}`;
    const reviews = (state.reviews ?? []).filter(r => state.project === 'all' || r.project.split('/').pop() === state.project);
    setWorkCount(items.filter(x => x.column === 'needs-you').length + asking.length); // the Needs you group's own count
    const groups = COLUMNS.map(c => {
        const list = items.filter(x => x.column === c.key), extra = c.key === 'doing' ? [...placeholders, ...working] : c.key === 'needs-you' ? asking : [];
        if (!list.length && !extra.length) {
            return null;
        }
        if (c.key === 'done') {
            return foldGroup(c, list, !!state.showMerged, v => { state.showMerged = v; });
        }
        if (c.key === 'finished') {
            return foldGroup(c, list, store.get(finishedKey) === 'open', v => store.set(finishedKey, v ? 'open' : 'closed'));
        }
        if (c.key === 'review') { // open until it grows past a few rows, then folded, unless the user chose
            const chosen = store.get(reviewKey);
            return foldGroup(c, list, chosen ? chosen === 'open' : list.length <= 3, v => store.set(reviewKey, v ? 'open' : 'closed'), reviewNote(list));
        }
        const h = el('h2', 'g-head');
        h.append(dot(c.key), `${c.label} · ${list.length + extra.length}`);
        const t = itemTable(list);
        t.append(...extra); // after the item rows: a fixed-layout table takes its column widths from the first row, and this one spans them all
        const sec = el('section', `group g-${c.key}`);
        sec.append(h, t);
        return sec;
    }).filter(Boolean);
    if (reviews.length) { // after Needs you, else first
        const h = el('h2', 'g-head'), t = el('table', 'rows'), sec = el('section', 'group g-reviews');
        h.append(dot('review'), `Review requested · ${reviews.length}`);
        t.append(...reviews.map(reviewRow));
        sec.append(h, t);
        groups.splice(groups.findIndex(g => g.classList.contains('g-needs-you')) + 1, 0, sec);
    }
    const hadFocus = $('masters').contains(document.activeElement); // replaceChildren drops it; keys.js puts it back
    const empty = !groups.some(g => g.localName === 'section' || g.classList.contains('g-review')) && el('div', groups.length ? 'd-empty' : 'welcome', 'No MRs or subagents right now');
    $('masters').replaceChildren(...[empty, ...groups].filter(Boolean));
    hooks.rendered?.(hadFocus);
}

// "💬 2 new · Børre" in the accent colour, or a muted "💬 5" when none are new since last checked.
/** @param {WorkItem} x @param {ReviewComment[]} fresh */
function commentBadge(x, fresh) {
    const b = el('span', 'cm-badge' + (fresh.length ? ' new' : ''), fresh.length ? `💬 ${fresh.length} new · ${authorSummary(fresh)}` : `💬 ${x.comments.count}`);
    b.setAttribute('aria-label', fresh.length ? `${fresh.length} new comments` : `${x.comments.count} comments, none new`);
    return b;
}
const markAllSeen = () => {
    for (const x of state.sessions.flatMap(s => s.items || [])) {
        if (x.pr) {
            markSeen(x.pr);
        }
    }
    renderBoard();
    updateTitle();
};

// Optimistic "sent" marks: item key -> click time, in memory and sessionStorage, until the server reports the item
// requested or doing, or SENT_MS pass without that (then the button comes back with a hint).
const SENT_MS = 120_000;
const sent = new Map((() => {
    try {
        return JSON.parse(sessionStorage.getItem('sent')) ?? [];
    } catch {
        return [];
    }
})());
const unanswered = new Map(); // key -> action label whose mark timed out
const saveSent = () => {
    try {
        sessionStorage.setItem('sent', JSON.stringify([...sent]));
    } catch {}
};
/** @param {WorkItem} x @returns {WorkItem} */
function optimistic(x, now = Date.now()) {
    const at = sent.get(x.key);
    if (at == null) {
        return x;
    }
    if (x.requested || x.column === 'doing' || now - at > SENT_MS) {
        sent.delete(x.key);
        saveSent();
        if (!x.requested && x.column !== 'doing') {
            unanswered.set(x.key, x.action?.label);
        }
        return x;
    }
    return { ...x, sent: at, column: 'doing', next: 'Sent to Claude…' };
}
/** @param {WorkItem} x */
function sentPill(x) {
    const p = el('span', 'sent-pill');
    p.append(el('span', 'pulse'), x.sent ? 'Sent to Claude…' : 'Claude is on it…');
    p.setAttribute('role', 'status');
    return p;
}

// The row's one-click command (label and message from the server's rowAction): binds the chat to the item's session and sends
// there; the row turns into an in-progress one at once, without the button, so it can't be sent twice.
/** @param {WorkItem} x */
function actionButton(x) {
    const b = waButton(x.action.label, 'act-btn');
    b.onclick = async e => {
        e.stopPropagation();
        if (sent.has(x.key)) {
            return;
        }
        sent.set(x.key, Date.now());
        saveSent();
        unanswered.delete(x.key);
        if (x.sessionId !== chatSession()?.id) {
            bindChat(x.sessionId);
        } else {
            renderBoard();
        }
        setTimeout(renderBoard, SENT_MS + 500);
        // a failed send drops the sent mark; sendText shows the error
        if (!await sendText(x.sessionId, x.action.message, undefined, undefined, true)) {
            sent.delete(x.key);
            saveSent();
            renderBoard();
        }
    };
    return [b, tooltip(b, x.action.message)];
}

// Click toggles an inline detail (TLDR with Show more, other agents on the item, edited files) and binds the chat to the item's session.
/** @param {WorkItem} x */
export function select(x) {
    state.selected = state.selected === x.key ? null : x.key;
    // opening marks the MR seen; the detail still lists what was new until then
    if (state.selected && x.pr) {
        state.opened = { key: x.key, since: seenAt(x.pr) };
        markSeen(x.pr);
        updateTitle();
    }
    if (state.selected && x.sessionId && x.sessionId !== chatSession()?.id) { // opening only: closing a detail leaves the chat alone
        (x.column === 'needs-you' ? focusChat : bindChat)(x.sessionId);
    } else {
        renderBoard();
    }
}
/** @param {WorkItem} x */
function detail(x) {
    const d = el('div', 'detail');
    if (x.pr || x.branch) {
        const m = el('div', 'd-mr');
        m.append(...prParts(x), ...(x.branch ? [el('span', 'chip mono', x.branch)] : []));
        d.append(m);
    }
    if (x.comments?.count) {
        const fresh = freshComments(x.comments, state.opened?.key === x.key ? state.opened.since : seenAt(x.pr));
        const h = el('h4', null, fresh.length ? `New comments · ${fresh.length}` : `Comments · ${x.comments.count} · none new`), all = el('button', 'show mark-all', 'Mark all seen');
        all.onclick = markAllSeen;
        h.append(all);
        d.append(h);
        if (fresh.length) {
            const ul = el('ul', 'comments');
            ul.append(...fresh.map(c => {
                const li = el('li'), a = el('a', null, c.excerpt || '(no text)');
                a.href = c.url;
                a.target = '_blank';
                li.append(el('b', null, c.author), el('span', 'muted', ` · ${ago(Date.parse(c.at))}${c.resolved === false ? ' · unresolved' : ''} · `), a);
                return li;
            }));
            d.append(ul);
        }
    }
    if (x.tldr || x.body) {
        d.append(...foldable(x.tldr, x.body, `item:${x.key}`));
    }
    if (x.activity?.length) {
        const ul = el('ul', 'activity');
        ul.append(...x.activity.map(a => {
            const li = el('li'), badge = el('wa-badge', null, a.status);
            badge.setAttribute('variant', 'neutral');
            badge.setAttribute('appearance', 'filled');
            badge.setAttribute('pill', '');
            li.append(badge, ' ', el('b', null, a.description), a.tldr ? ` — ${plain(a.tldr)}` : '');
            return li;
        }));
        d.append(el('h4', null, `Earlier agents · ${x.activity.length}`), ul);
    }
    if (x.files?.length) {
        const ul = el('ul', 'files');
        ul.append(...x.files.map(f => {
            const li = el('li'), i = f.lastIndexOf('/');
            li.title = f;
            li.append(f.slice(0, i + 1), el('b', null, f.slice(i + 1)));
            return li;
        }));
        d.append(el('h4', null, `Files edited · ${x.files.length}`), ul);
    }
    if (!d.querySelector(':scope > :not(.d-mr)')) {
        d.append(el('p', 'muted', 'Nothing to show yet.'));
    }
    d.onclick = e => e.stopPropagation();
    return d;
}
// Lifecycle Implement → Verify → Review → Approved → Merged; the current segment pulses while an agent runs.
/** @param {WorkItem} x */
function stageBar(x) {
    const w = el('div', 'stage'), bar = el('div', 'bar');
    w.style.setProperty('--c', `var(${COL[x.column].color})`);
    LIFECYCLE.forEach((name, i) => {
        const s = el('i', i < x.stage ? 'on' : i === x.stage ? (x.agentStatus === 'running' || x.sent || x.requested ? 'on now' : 'on') : '');
        s.title = name;
        bar.append(s);
    });
    w.append(bar, el('small', null, x.stageLabel));
    return w;
}

export function renderBoard() {
    if (!state.tracked.length) {
        const w = el('div', 'welcome'), b = waButton('+ Add projects', null, { variant: 'success', appearance: 'accent', size: 'm' });
        w.append(el('h2', null, 'No projects on your board'), el('div', null, 'Pick the projects you want to follow. Sessions from other projects stay hidden.'), b);
        b.onclick = () => $('manage').click();
        return $('masters').replaceChildren(w);
    }
    renderItems();
}

// Transitions into an attention state since the previous poll, at most one per item, plus a comment event per item with
// comments newer than both its seen time and the previous poll's newest. No previous poll (or comments not loaded then), no events.
/**
 * @param {WorkItem[] | undefined} prevItems
 * @param {WorkItem[]} nextItems
 * @param {(x: WorkItem) => number} [seen]
 * @returns {AttentionEvent[]}
 */
export function attentionEvents(prevItems, nextItems, seen = () => 0) {
    if (!prevItems) {
        return [];
    }
    const before = new Map(prevItems.map(x => [x.key, x])), nextKeys = new Set(nextItems.map(x => x.key));
    const failing = /** @param {WorkItem | undefined} x */ x => x?.prState?.ci === 'failing';
    const events = nextItems.flatMap(x => {
        const p = before.get(x.key), was = p?.column;
        const kind = x.column === 'needs-you' && was !== 'needs-you' ? 'needs-you'
            : x.column === 'ready' && was !== 'ready' ? 'ready'
            : was === 'doing' && (x.column === 'review' || x.column === 'done' || x.column === 'finished') ? 'finished'
            : failing(x) && !failing(p) ? 'failing' : null;
        return kind ? [/** @type {AttentionEvent} */ ({ kind, item: x })] : [];
    });
    const comments = nextItems.flatMap(x => {
        const p = before.get(x.key);
        if (!x.pr || !x.comments || !p?.comments) {
            return [];
        }
        const fresh = freshComments(x.comments, Math.max(seen(x), Date.parse(p.comments.latestAt) || 0));
        return fresh.length ? [/** @type {AttentionEvent} */ ({ kind: 'comment', item: x, comments: fresh })] : [];
    });
    // one notification per item: a comment that moved it into needs-you is told as the comment
    const commented = new Set(comments.map(e => e.item.key));
    // finished agents without an MR drop off the board
    return [...events.filter(e => !(e.kind === 'needs-you' && commented.has(e.item.key))), ...comments, ...prevItems.filter(p => p.column === 'doing' && !nextKeys.has(p.key)).map(item => /** @type {AttentionEvent} */ ({ kind: 'finished', item }))];
}

// Sessions that started waiting on the user (asking, or needs you) since the previous poll. No previous poll, no events.
/** @param {Session[] | undefined} prev @param {Session[]} next @returns {AttentionEvent[]} */
export function askingEvents(prev, next) {
    if (!prev) {
        return [];
    }
    const was = new Set(prev.filter(waitsOnYou).map(s => s.id));
    return next.filter(s => waitsOnYou(s) && !was.has(s.id)).map(session => /** @type {AttentionEvent} */ ({ kind: 'asking', session }));
}
