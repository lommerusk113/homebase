// Shared state and DOM helpers. No DOM access at import time, so node can import the modules that use it.
// marked and DOMPurify are globals from index.html's <script> tags.

/** @type {{ key: Column, label: string, color: string }[]} */
export const COLUMNS = [
    { key: 'needs-you', label: 'Needs you', color: '--c-needs' },
    { key: 'doing', label: 'Doing', color: '--c-doing' },
    { key: 'review', label: 'In review', color: '--c-review' },
    { key: 'ready', label: 'Ready to merge', color: '--c-ready' },
    { key: 'finished', label: 'Recently finished', color: '--c-done' },
    { key: 'done', label: 'Merged', color: '--c-done' }
];
export const COL = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
export const LIFECYCLE = ['Implement', 'Verify', 'Review', 'Approved', 'Merged'];

export const store = {
    get: k => {
        try {
            return window.localStorage.getItem(k);
        } catch {
            return null;
        }
    },
    set: (k, v) => {
        try {
            window.localStorage.setItem(k, v);
        } catch {}
    }
};
const parse = v => {
    try {
        return JSON.parse(v) || [];
    } catch {
        return [];
    }
};
// ponytail: tracked list lives in this browser's localStorage; move to a projects.json if you want it across browsers
/**
 * @type {{ sessions: Session[], tracked: string[], project: string, selected: string | null, chat: string | null, unfold: Set<string>,
 *   outbox: OutboxItem[], nudged: Set<string>, offline?: boolean, limits?: Limits | null, asking?: string | null, items?: WorkItem[], editors?: Editor[],
 *   opened?: { key: string, since: number }, showMerged?: boolean, starting?: string | null, startingTmux?: string | null, boot?: { question: string, options: string[], selected: number } | null }}
 */
export const state = { sessions: [], tracked: parse(store.get('tracked')), project: store.get('project') || 'all', selected: null, chat: store.get('chat'), unfold: new Set(), outbox: [], nudged: new Set(), limits: null };
export const saveTracked = () => { store.set('tracked', JSON.stringify(state.tracked)); };

// Every API call goes through here: the per-start token from index.html's meta tag, plus x-codetool on POSTs.
// A 401 means the server restarted with a new token: read it from a fresh index.html (one fetch shared by concurrent
// callers) and retry once. A 401 is rejected before any handler runs, so retrying a POST can't double-send.
// Never reloads, so typed text and UI state survive; a second 401 goes back to the caller, which shows the offline
// state and keeps polling.
export const page = { token: null, build: null, updated: false };
const metaOf = (html, name) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
const ownMeta = name => /** @type {HTMLMetaElement | null} */ (globalThis.document?.querySelector(`meta[name="${name}"]`))?.content ?? null;
let tokenFetch = null;
export function refreshToken() {
    return tokenFetch ??= fetch('/', { cache: 'no-store' })
        .then(r => (r.ok ? r.text() : ''))
        .then(html => {
            const token = metaOf(html, 'homebase-token'), build = metaOf(html, 'homebase-build');
            if (metaOf(html, 'homebase-pair')) { // this remote device was revoked: show the pair page
                globalThis.location?.assign('/');
            }
            if (token) {
                page.token = token;
            }
            page.build ??= ownMeta('homebase-build');
            // new code under a running page: say so in the header, never reload on our own
            if (build && page.build && build !== page.build && !page.updated) {
                page.updated = true;
                globalThis.document?.getElementById('updated')?.removeAttribute('hidden');
            }
            return page.token;
        })
        .catch(() => page.token)
        .finally(() => { tokenFetch = null; });
}
/**
 * @param {string} path
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
export async function api(path, opts = {}) {
    page.token ??= ownMeta('homebase-token');
    const send = token => fetch(path, { signal: AbortSignal.timeout(15_000), ...opts, headers: { ...opts.headers, 'x-homebase-token': token, ...(opts.method === 'POST' && { 'x-codetool': '1' }) } });
    const used = page.token, r = await send(used);
    if (r.status !== 401) {
        return r;
    }
    const token = page.token !== used ? page.token : await refreshToken(); // another caller may have the new one already
    return token && token !== used ? send(token) : r;
}

// Plain sentences for the raw server and tmux errors the chat can show; anything else passes through.
/** @type {[RegExp, string][]} */
const FRIENDLY = [
    [/^busy$/, "Claude is busy; try again when it's idle"],
    [/^unknown session/, 'That session is gone. Pick another one from the list.'],
    [/^bad tmux name/, "This chat's terminal name isn't valid. Reload the page and try again."],
    [/ENOENT/, "tmux isn't installed"],
    [/Command failed: tmux|no server running|can't find (session|pane)|no current (session|target)/i, "Couldn't reach this chat's terminal. It may have ended; try Restart chat."]
];
/** @param {string} msg */
// What the ask card showed, as a short FNV-1a hash of the question and the command or diff: sent with an answer, so the
// server (startup.mjs answerStartup, which imports this) approves only that exact prompt and never one that replaced it.
/** @param {{ question: string, detail?: string }} q */
export const seenHash = q => {
    let h = 0x811c9dc5;
    for (const c of `${q.question}\n${q.detail ?? ''}`) {
        h = Math.imul(h ^ c.codePointAt(0), 0x01000193);
    }

    return (h >>> 0).toString(36);
};

export const friendly = msg => FRIENDLY.find(([re]) => re.test(msg))?.[1] ?? msg;

/**
 * getElementById, typed for the index.html elements listed in types.d.ts's PageIds.
 * @template {string} K
 * @param {K} id
 * @returns {K extends keyof PageIds ? PageIds[K] : HTMLElement}
 */
export const $ = id => /** @type {any} */ (document.getElementById(id));
// Failed poll (network, 401, non-OK): header "Offline", list dimmed with its "Disconnected" note. The next good poll clears it.
export const setOffline = off => {
    state.offline = off;
    $('offline').hidden = !off;
    document.body.classList.toggle('disconnected', off);
};
// Header warning when Claude Code's transcript or screen no longer parses: any reason shown keeps it up.
/** @type {Set<string>} */
const formatReasons = new Set();
/** @param {string} reason @param {boolean} on */
export const setFormatWarn = (reason, on) => {
    formatReasons[on ? 'add' : 'delete'](reason);
    $('format-warn').hidden = !formatReasons.size;
};
/**
 * @template {string} K
 * @param {K} tag
 * @param {string | null} [cls]
 * @param {string | number | null} [text]
 * @returns {K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement}
 */
export const el = (tag, cls, text) => {
    const e = /** @type {any} */ (document.createElement(tag));
    if (cls) {
        e.className = cls;
    }
    if (text != null) {
        e.textContent = text;
    }
    return e;
};
// Web Awesome button; attributes rather than properties so it works before the element is upgraded.
/** @param {string} text @param {string | null} [cls] @param {Record<string, any>} [attrs] */
export const waButton = (text, cls, attrs = {}) => {
    const b = el('wa-button', cls, text);
    for (const [k, v] of Object.entries(/** @type {Record<string, string | boolean>} */ ({ size: 's', appearance: 'outlined', ...attrs }))) {
        b.setAttribute(k, v === true ? '' : v);
    }
    return b;
};
// A <wa-tooltip> for target (given an id if it has none); the caller places it next to the target.
let tipCount = 0;
/** @param {HTMLElement} target @param {string} text */
export const tooltip = (target, text) => {
    target.id ||= `tip-${++tipCount}`;
    const t = el('wa-tooltip', null, text);
    t.setAttribute('for', target.id);
    return t;
};

// A link that opens in a new tab.
/** @param {string | null} cls @param {string} text @param {string} href */
export const link = (cls, text, href) => {
    const a = el('a', cls, text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
};

export const plain = t => (t || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
export const ago = ms => {
    const s = (Date.now() - ms) / 1000;
    return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`;
};
// Whole minutes as "45m" / "1h" / "1h20m".
const hoursMinutes = m => (m < 60 ? `${m}m` : `${m / 60 | 0}h${m % 60 ? m % 60 + 'm' : ''}`);
// Rate-limit window -> % left and time to reset, as Contado's footer shows it: "70%" and "1h20m" / "4d22h" / "45m".
/** @param {LimitWindow} w */
export const limitLeft = (w, now = Date.now()) => {

    const m = Math.max(0, w.resetsAt - now) / 60000 | 0, d = m / 1440 | 0, h = m % 1440 / 60 | 0;
    const until = d ? `${d}d${h ? h + 'h' : ''}` : hoursMinutes(m);

    return { left: Math.max(0, Math.min(100, Math.round(100 - w.used))), until };
};
// Minutes until the window is empty at the pace of its samples [[time, used%]], or null when that is after the reset, the pace is flat or the samples span under 2 minutes.
/** @param {[number, number][]} samples @param {number} resetsAt @returns {number | null} */
export const runOutIn = (samples, resetsAt, now = Date.now()) => {
    const [t0, u0] = samples[0] ?? [], [t1, u1] = samples.at(-1) ?? [];
    if (samples.length < 2 || t1 - t0 < 120_000 || u1 <= u0) {
        return null;
    }
    const min = (100 - u1) / ((u1 - u0) / (t1 - t0)) / 60000;

    return now + min * 60000 < resetsAt ? Math.max(1, Math.round(min)) : null;
};
export const NEEDS_ANSWER = 'Claude needs your answer';
// Claude's newest reply when it says something still waits on the user (its "Waiting on you: …") and that isn't answered.
/** @param {{ items?: ChatItem[] } | null} d */
export const openDecision = d => {
    const i = d?.items?.findLast(x => x.role === 'assistant');
    return i?.waiting && !i.answer && !i.error ? i : null;
};
// Chat status bar: a failed poll wins (never claim "Idle" on data we couldn't fetch), then asking over working
// (Claude waits on you); working counts from the turn start (`since`), else from your last message. Idle says whether
// Claude's last reply wants you (or its newest reply still waits on you, said since or not) and whether its agents
// still work, from the session `s`.
/** @param {(Partial<Transcript> & { error?: boolean }) | null} d @param {Pick<Session, 'needsYou' | 'subagents' | 'step'> | null} [s] */
export const chatStatus = (d, now = Date.now(), s = null) => {
    if (d?.error) {
        return { kind: 'error', text: 'Can’t reach Homebase — reconnecting…' };
    }
    if (d?.asking) {
        return { kind: 'asking', text: 'Claude is asking — see the question above' };
    }
    if (d?.stuck && !d.working) {
        return { kind: 'stuck', text: 'No activity for 30 min — Claude may be stuck' };
    }
    if (!d?.working) {
        const n = s?.subagents?.running ?? 0, agents = n ? ` · ${n} agent${n === 1 ? '' : 's'} still working` : '';
        return { kind: 'idle', text: `${s?.needsYou || openDecision(d) ? NEEDS_ANSWER : 'Claude is done'}${agents}` };
    }
    const at = d.since ?? Date.parse(d.items?.findLast(i => i.role === 'user' && !i.pending)?.at);
    const m = (now - at) / 60000 | 0;

    return { kind: 'working', text: `Claude is working…${m > 0 ? ` · ${hoursMinutes(m)}` : ''}${s?.step ? ` · ${s.step}` : ''}` };
};
// Context window use, as a level for the gauge colour: amber from 60%, red from 85%.
/** @param {number} p @returns {'' | 'warn' | 'hot'} */
export const ctxLevel = p => (p >= 85 ? 'hot' : p >= 60 ? 'warn' : '');
// /compact only runs on an idle Claude: no open turn, nothing asking (the server refuses otherwise).
/** @param {Session} s */
export const canCompact = s => s.status !== 'working' && !s.asking;
// Compact thresholds are absolute tokens, so a 1M window compacts as early as a 200k one: nudge at 150k, auto at 200k,
// as a percent of the session's window (1M when the dump doesn't say; never above 90%).
// Auto-compact: idle for 2 min, context over its threshold, and not tried for an hour (lastAt: when this page last sent it for this session).
export const AUTO_COMPACT = { nudgeTokens: 150_000, tokens: 200_000, windowTokens: 1_000_000, idleMs: 2 * 60_000, everyMs: 3600_000 };
/** @param {number} tokens @param {Pick<Session, 'contextSize'>} s */
export const tokenPercent = (tokens, s) => Math.min(90, tokens / (s.contextSize || AUTO_COMPACT.windowTokens) * 100);
/** @param {Session} s */
export const compactNudgeDue = s => (s.context ?? 0) >= tokenPercent(AUTO_COMPACT.nudgeTokens, s);
/** @param {Session} s @param {number} now @param {number} lastAt */
export const autoCompactDue = (s, now, lastAt) => canCompact(s)
    && (s.context ?? 0) >= tokenPercent(AUTO_COMPACT.tokens, s)
    && now - (s.lastActivity ?? s.updated) >= AUTO_COMPACT.idleMs
    && now - lastAt >= AUTO_COMPACT.everyMs;
// Limits strip item: "Session 70%" at a glance, details in the tooltip; the countdown shows inline only once under 20% is left.
/** @param {boolean | number} week @param {LimitWindow} w */
export const limitView = (week, w, now = Date.now()) => {
    const { left, until } = limitLeft(w, now), at = new Date(w.resetsAt), pad = n => String(n).padStart(2, '0');
    const when = `${week ? at.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' : ''}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return {
        label: week ? 'Week' : 'Session', left, when,
        text: `${left}%${left < 20 ? ` · resets ${until}` : ''}`,
        tip: `${left}% left of your ${week ? 'weekly' : '5-hour'} limit · resets in ${until} (${when})`,
    };
};
export const prLabel = url => {
    const m = url.match(/merge_requests\/(\d+)/) || url.match(/pull\/(\d+)/);
    return m ? (url.includes('merge_requests') ? '!' : '#') + m[1] : 'PR';
};
/** @param {{ pr: string, prState?: PrState | null }} s */
export const prChip = s => {
    // "open" is the usual case, so only merged/closed are spelled out
    const a = el('a', 'chip mono', `${prLabel(s.pr)}${s.prState && s.prState.state !== 'open' ? ' · ' + s.prState.state : ''}`);
    a.href = s.pr;
    a.target = '_blank';
    a.onclick = e => e.stopPropagation();
    return a;
};

// Scan aids on rendered markdown: PR/MR links become chips, file paths become inline code, and !123/#123 (bare or in
// backticks) become light accent text: chips for every ref made bold sentences hard to read.
const PR_HREF = /^https:\/\/\S+?\/(?:-\/merge_requests|pull)\/\d+\/?$/;
const CHIP_OR_PATH = /(^|[\s(\[])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?|[\w.@+-]+(?:\/[\w.@+-]+)+\.[a-z]\w{0,5}|[!#]\d+\b)/gi;
function enrich(root) {
    for (const a of root.querySelectorAll('a')) {
        a.target = '_blank';
        a.rel = 'noopener';
        if (PR_HREF.test(a.href) && a.textContent.startsWith('http')) {
            a.textContent = prLabel(a.href);
            a.className = 'chip mono';
            a.title = a.href;
        }
    }
    for (const c of root.querySelectorAll(':not(pre) > code')) {
        if (/^[!#]\d+$/.test(c.textContent)) {
            c.replaceWith(el('span', 'ref', c.textContent));
        }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('a, code, pre, .ref') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    /** @type {Text[]} */
    const nodes = [];
    while (walker.nextNode()) {
        nodes.push(/** @type {Text} */ (walker.currentNode));
    }
    for (const n of nodes) {
        const t = n.textContent;
        if (!t.match(CHIP_OR_PATH)) {
            continue;
        }
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of t.matchAll(CHIP_OR_PATH)) {
            const start = m.index + m[1].length, tok = m[2].replace(/[.,:;]+$/, '');
            frag.append(t.slice(last, start), /^[!#]/.test(tok) ? el('span', 'ref', tok) : el('code', null, tok));
            last = start + tok.length;
        }
        frag.append(t.slice(last));
        n.replaceWith(frag);
    }
    return root;
}
/** @param {string} text @param {boolean} [inline] */
export const rich = (text, inline) => {
    const d = el('div', inline ? 'lead' : 'body');
    d.innerHTML = DOMPurify.sanitize(inline ? marked.parseInline(text) : marked.parse(text || ''));
    return enrich(d);
};

// First sentence of a message without a TLDR, capped near 200 chars, with dangling ** or ` closed.
function lead(text) {
    const line = (text || '').split('\n').map(l => l.trim()).find(l => l && !/^(```|\||---|<)/.test(l)) || '';
    const s = line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '');
    let cut = s.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s;
    const long = cut.length > 200;
    if (long) {
        cut = cut.slice(0, 200).replace(/\s+\S*$/, '');
    }
    if ((cut.match(/\*\*/g)?.length ?? 0) % 2) {
        cut += '**';
    }
    if ((cut.match(/`/g)?.length ?? 0) % 2) {
        cut += '`';
    }
    return long ? cut + '…' : cut;
}
// Collapsed: only the TLDR (or the lead sentence). Show more reveals the rest; open state survives re-renders via state.unfold.
/** @param {string | null | undefined} tldr @param {string | undefined} rest @param {string} key @returns {HTMLElement[]} */
export function foldable(tldr, rest, key) {
    const head = tldr || lead(rest), more = tldr || rest?.trim() !== head ? rest?.trim() : '';
    const top = rich(head, true);
    if (!more) {
        return [top];
    }
    const body = rich(more), btn = el('button', 'show');
    const set = open => {
        body.hidden = !open;
        if (!tldr) {
            top.hidden = open;
        }
        btn.textContent = open ? 'Show less' : 'Show more';
        btn.setAttribute('aria-expanded', String(open));
    };
    set(state.unfold.has(key));
    btn.onclick = e => {
        e.stopPropagation();
        const open = !state.unfold.has(key);
        if (open) {
            state.unfold.add(key);
        } else {
            state.unfold.delete(key);
        }
        set(open);
    };
    return [top, body, btn];
}

// Plug-in points: app.js sets hooks.inMilestone to milestone.js's inMilestone(item, selected), hooks.milestoneId to the picked one, hooks.refresh for keys.js's r and hooks.setProject for its [ and ];
// keys.js sets hooks.rendered, which list.js and issues.js call after each render.
/** @type {{ inMilestone: (x: WorkItem) => boolean, milestoneId: () => number | null, refresh: () => void, setProject: (name: string) => void, rendered?: (refocus: boolean) => void }} */
export const hooks = { inMilestone: () => true, milestoneId: () => null, refresh: () => {}, setProject: () => {} };

/** @param {{ project: string }} x */
export const isTracked = x => state.tracked.includes(x.project);
// In a tracked project and in the selected one (or "All").
/** @param {{ project: string }} x */
export const inView = x => isTracked(x) && (state.project === 'all' || x.project === state.project);
/** @returns {Session[]} */
export const visibleSessions = () => state.sessions.filter(inView);
// Waits on the user: a question or permission prompt, or idle with a reply that asks for a decision.
/** @param {Session} s */
export const waitsOnYou = s => !s.sidechain && (s.asking || (s.needsYou && s.status !== 'working'));
// Tracked projects (by name) with something waiting on you, for the header chips: Needs you items plus chats asking or needing you.
/** @param {Session[]} sessions @param {string[]} tracked @returns {{ project: string, waiting: number }[]} */
export function projectCounts(sessions, tracked) {
    return [...tracked].sort((a, b) => a.localeCompare(b)).map(project => {
        const mine = sessions.filter(s => s.project === project);
        return { project, waiting: mine.flatMap(s => s.items || []).filter(x => x.column === 'needs-you').length + mine.filter(waitsOnYou).length };
    }).filter(c => c.waiting > 0);
}
// "Since last checked" per MR: seen:<mrUrl> in localStorage. An MR never seen before counts as seen now, so the first load doesn't flood.
/** @param {string} pr @returns {number} */
export const seenAt = pr => {
    const v = Number(store.get(`seen:${pr}`));
    if (v) {
        return v;
    }
    const now = Date.now();
    store.set(`seen:${pr}`, now);
    return now;
};
export const markSeen = (pr, at = Date.now()) => store.set(`seen:${pr}`, at);
/** @param {Comments | null} c @param {number} seen @returns {ReviewComment[]} */
export const freshComments = (c, seen) => (c?.items ?? []).filter(i => Date.parse(i.at) > seen);
export const firstName = n => n.split(/\s+/)[0];
// "Børre" / "Børre, Ann" / "Børre, Ann +1": distinct first names, at most two
/** @param {ReviewComment[]} items */
export const authorSummary = items => {
    const n = [...new Set(items.map(i => firstName(i.author)))];
    return n.slice(0, 2).join(', ') + (n.length > 2 ? ` +${n.length - 2}` : '');
};
/** @param {WorkItem} x */
const newCount = x => (x.pr ? freshComments(x.comments, seenAt(x.pr)).length : 0);
// Counts every tracked project, not only the selected one: the tab title is how another project's waiting chat gets seen.
export function updateTitle() {
    const tracked = state.sessions.filter(isTracked);
    // the chat's own poll can see its question before the session list does; max, so it isn't counted twice
    const asking = Math.max(tracked.filter(waitsOnYou).length, state.asking ? 1 : 0);
    const n = tracked.flatMap(s => s.items || []).filter(x => x.column === 'needs-you' || x.column === 'ready' || newCount(x)).length + asking;
    document.title = n ? `(${n}) Homebase` : 'Homebase';
}
