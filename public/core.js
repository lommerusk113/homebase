// Shared state and DOM helpers. No DOM access at import time, so node can import the modules that use it.
// marked and DOMPurify are globals from index.html's <script> tags.

/** @type {{ key: Column, label: string, color: string }[]} */
export const COLUMNS = [
    { key: 'needs-you', label: 'Needs you', color: '--c-needs' },
    { key: 'doing', label: 'Doing', color: '--c-doing' },
    { key: 'unknown', label: 'Not checked', color: '--c-idle' },
    { key: 'review', label: 'In review', color: '--c-review' },
    { key: 'ready', label: 'Ready to merge', color: '--c-ready' },
    { key: 'finished', label: 'Recently finished', color: '--c-done' },
    { key: 'done', label: 'Merged', color: '--c-done' },
    { key: 'closed', label: 'Closed without merging', color: '--c-done' }
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
// The ? overlay's switch: with single-character shortcuts off, a letter, digit or symbol key does nothing outside a
// text field. Enter, Space, the arrows, Esc and ? (the way back to the switch) stay.
/** @param {KeyboardEvent} e */
export const plainKeysOff = e => e.key.length === 1 && e.key !== ' ' && e.key !== '?' && store.get('keys') === 'off';
const parse = v => {
    try {
        return JSON.parse(v) || [];
    } catch {
        return [];
    }
};
// The tracked list is the server's (tracked.json, shared with paired phones); localStorage keeps this browser's copy for a fast first paint.
/**
 * @type {{ sessions: Session[], tracked: string[], project: string, selected: string | null, chat: string | null, unfold: Set<string>,
 *   outbox: OutboxItem[], nudged: Set<string>, offline?: boolean, serverError?: boolean, formatWarn?: boolean, update?: { server: boolean, reloading: boolean } | null, asking?: string | null, reviews?: ReviewRequest[], items?: WorkItem[],
 *   opened?: { key: string, since: number }, showMerged?: boolean, starting?: string | null, startingTmux?: string | null, focus?: string | null, helper?: { sid: string, id: string, description: string } | null, boot?: { question: string, options: string[], selected: number } | null }}
 */
export const state = { sessions: [], tracked: parse(store.get('tracked')), project: store.get('project') || 'all', selected: null, chat: store.get('chat'), unfold: new Set(), outbox: [], nudged: new Set() };
// The picked project must be on the board: one that was removed falls back to "All my projects".
export const checkProject = () => {
    if (state.project !== 'all' && !state.tracked.includes(state.project)) {
        state.project = 'all';
    }
};
export const saveTracked = () => {
    store.set('tracked', JSON.stringify(state.tracked));
    api('/api/tracked', { method: 'POST', body: JSON.stringify(state.tracked) }).catch(() => {});
};

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
            // new code under a running page: the header says so (app.js refreshVersion), never reload on our own
            if (build && page.build && build !== page.build) {
                page.updated = true;
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

/**
 * getElementById, typed for the index.html elements listed in types.d.ts's PageIds.
 * @template {string} K
 * @param {K} id
 * @returns {K extends keyof PageIds ? PageIds[K] : HTMLElement}
 */
export const $ = id => /** @type {any} */ (document.getElementById(id));
// Failed poll (network, 401, non-OK): header "Offline" (the Header island reads state.offline), list dimmed with its "Disconnected" note. The next good poll clears it.
// status: the HTTP status of the answer, if one came. A 500 is Homebase itself failing, not the connection (a proxy in
// front answers 502-504 while Homebase is down), and is named so.
/** @param {boolean} off @param {number} [status] */
export const setOffline = (off, status) => {
    const failed = off && status === 500, changed = off !== Boolean(state.offline) || failed !== Boolean(state.serverError);
    state.offline = off;
    state.serverError = failed;
    if (changed) {
        vue.bump();
    }
    document.body.classList.toggle('disconnected', off);
    document.body.classList.toggle('server-error', failed);
    document.querySelector('.stale-note').textContent = `${failed ? 'Homebase hit an error (see its log)' : 'Disconnected'} — showing the last known data`;
};
// Header warning when Claude Code's transcript or screen no longer parses: any reason shown keeps it up
// (state.formatWarn, drawn by the Header island next to the server's own version warning).
/** @type {Set<string>} */
const formatReasons = new Set();
/** @param {string} reason @param {boolean} on */
export const setFormatWarn = (reason, on) => {
    formatReasons[on ? 'add' : 'delete'](reason);
    if (Boolean(state.formatWarn) !== formatReasons.size > 0) {
        state.formatWarn = formatReasons.size > 0;
        vue.bump();
    }
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
// A touch screen (phone, tablet): no hover, so no tooltips, and a thumb is less exact than a mouse.
export const touch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
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

// Marks a reply as handled: a "needs you" Claude got wrong. The server then says so to the chat, the board and push.
/** @param {string} sid @param {string} reply */
export async function markHandled(sid, reply) {
    const r = await api(`/api/handled?id=${encodeURIComponent(sid)}&reply=${encodeURIComponent(reply)}`, { method: 'POST' });
    if (!r.ok) {
        throw new Error(await r.text());
    }
}
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
const CHIP_OR_PATH = /(^|[\s(\[])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?|[\w.@+-]+(?:\/[\w.@+-]+)+\.[a-z]\w{0,5}|[!#]\d+\b)/gi;
// A huge table or code block shows its first rows or lines with a "Show all" step: thousands laid out at once freeze
// the page for seconds. Shown in full once asked, over re-renders too (state.unfold, keyed by size and start).
const MAX_ROWS = 200, MAX_LINES = 500;
function capBig(root) {
    /** @param {Element} at @param {string} label @param {string} key @param {() => void} restore */
    const step = (at, label, key, restore) => {
        const btn = el('button', 'show show-all', label);
        btn.onclick = e => {
            e.stopPropagation();
            state.unfold.add(key);
            restore();
            btn.remove();
        };
        at.after(btn);
    };
    for (const table of root.querySelectorAll('table')) {
        const rows = [...table.querySelectorAll('tbody > tr')], key = `all:${rows.length}:${rows[0]?.textContent.slice(0, 80)}`;
        if (rows.length > MAX_ROWS && !state.unfold.has(key)) {
            const rest = rows.slice(MAX_ROWS), body = rest[0].parentElement;
            rest.forEach(r => r.remove());
            step(table, `Show all ${rows.length} rows`, key, () => body.append(...rest.map(enrich)));
        }
    }
    for (const code of root.querySelectorAll('pre > code')) {
        const text = code.textContent, lines = text.split('\n'), key = `all:${text.length}:${text.slice(0, 80)}`;
        if (lines.length > MAX_LINES && !state.unfold.has(key)) {
            code.textContent = lines.slice(0, MAX_LINES).join('\n');
            step(code.parentElement, `Show all ${lines.length} lines`, key, () => { code.textContent = text; });
        }
    }
}
function enrich(root) {
    capBig(root); // first, so the rows held back are only walked when shown
    for (const a of root.querySelectorAll('a')) {
        if (typeof a.href === 'string' && lib.PR_HREF.test(a.href) && a.textContent.startsWith('http')) { // an SVG link's href is no string
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
// Reply text is untrusted (Claude repeats files and web pages), and marked passes raw HTML through. Only what marked
// itself emits survives: no <style>, style/id/class/name, forms or controls, embeds, data-/aria- attributes, so a reply
// can't restyle, cover or imitate the page where commands are approved. Links: http(s) and mailto only, always in a new
// tab without opener or referrer. Images: data: only, the one source the CSP lets a reply show.
const MD = {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt', 'align', 'start'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
};
// rich() is DOMPurify's only caller, so the hook is global. Node imports this file too (tests, the server), without DOMPurify.
typeof DOMPurify !== 'undefined' && DOMPurify.addHook('afterSanitizeAttributes', n => {
    if (n.tagName === 'A') {
        if (/^(https?|mailto):/i.test(n.getAttribute('href') ?? '')) {
            n.setAttribute('rel', 'noopener noreferrer');
            n.setAttribute('target', '_blank');
        } else {
            n.removeAttribute('href');
        }
    } else if (n.tagName === 'IMG' && !/^data:image\//i.test(n.getAttribute('src') ?? '')) {
        n.removeAttribute('src');
    }
});
// A task list's checkbox, the one form control marked emits, as a character.
const TASK_BOX = /<input (checked="" )?disabled="" type="checkbox">/g;
/** @param {string} text @param {boolean} [inline] */
export const rich = (text, inline) => {
    const d = el('div', inline ? 'lead' : 'body');
    const html = inline ? marked.parseInline(text) : marked.parse(text || '');
    d.innerHTML = DOMPurify.sanitize(html.replace(TASK_BOX, (_, on) => (on ? '☑' : '☐')), MD);
    return enrich(d);
};

// Collapsed: only the TLDR (or the lead sentence). Show more reveals the rest; open state survives re-renders via state.unfold.
/** @param {string | null | undefined} tldr @param {string | undefined} rest @param {string} key @returns {HTMLElement[]} */
export function foldable(tldr, rest, key) {
    const head = tldr || lead(rest), more = tldr || rest?.trim() !== head ? rest?.trim() : '';
    const top = rich(head, true);
    if (!more) {
        return [top];
    }
    const body = rich(more);
    return [top, body, foldButton(body, key, tldr ? null : top)];
}

// A fold's Show more button: opens body, and hides lead (a cut of the body) meanwhile. Open state survives re-renders via state.unfold.
/** @param {HTMLElement} body @param {string} key @param {HTMLElement | null} [lead] */
export function foldButton(body, key, lead) {
    const btn = el('button', 'show');
    const set = open => {
        body.hidden = !open;
        if (lead) {
            lead.hidden = open;
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
        if (open) {
            body.scrollIntoView({ block: 'nearest' }); // text taller than the pane starts at its top
        }
    };
    return btn;
}

// One line that opens: the line, its Show more next to it, the body under them.
/** @param {HTMLElement} line @param {HTMLElement} body @param {string} key */
export function foldLine(line, body, key) {
    const box = el('div', 'fold-line');
    box.append(line, foldButton(body, key), body);
    return box;
}

// Plug-in points: app.js sets hooks.refresh for keys.js's r, hooks.setProject for its [ and ] and hooks.reloadServer for the header's "Reload server";
// the Vue islands set hooks.inMilestone and hooks.milestoneId (the picked milestone, useMilestoneFilter), hooks.openProjects for g p (the Header island) and hooks.collapseIssue for Esc (useIssues);
// keys.js sets hooks.rendered, which list.js and the Issues island call after each render, and hooks.refocus, which diff.js calls when the element it was opened from is gone.
// The Limits island sets hooks.refreshLimits (the poll calls it); app.js sets hooks.openPairing (the projects dialog's "Pair a device…") and hooks.projectCreated (the new-project dialog's result).
/** @type {{ inMilestone: (x: WorkItem) => boolean, milestoneId: () => number | null, refresh: () => void, setProject: (name: string) => void, openProjects: () => void, refreshLimits: () => Promise<void>, openPairing?: () => void, projectCreated?: (p: { name: string, dir: string, sessionId: string | null, tmux?: string }) => void, reloadServer?: () => void, collapseIssue?: () => boolean, rendered?: (refocus: boolean) => void, refocus?: () => void }} */
export const hooks = { inMilestone: () => true, milestoneId: () => null, refresh: () => {}, setProject: () => {}, openProjects: () => {}, refreshLimits: async () => {} };

// The Vue islands (web/README.md). load() resolves to web/dist/main.js, or to null when web/ isn't built (the server
// then leaves its tags out of index.html). main.js sets bump when it loads: call it after changing state an island shows.
const WEB = '/web/main.js';
export const vue = {
    bump: () => {},
    /** @returns {Promise<{ mount(name: string, el: Element, props?: object): () => void } | null>} */
    load: () => (document.querySelector(`script[src="${WEB}"]`) ? import(WEB) : Promise.resolve(null))
};

// The pure helpers live in web/src/lib/*.ts (the unit tests and the server import them from there). The old page
// reaches them through `lib`, which web/src/old.ts fills when web/dist/main.js loads, so it has the very instances the
// islands use (the clock skew, for one). `moved` is a call through it: the re-exports below are for old code only, and go
// with the old code.
/** @typedef {typeof import('../web/src/lib/time.ts') & typeof import('../web/src/lib/limits.ts') & typeof import('../web/src/lib/forge.ts') & typeof import('../web/src/lib/text.ts') & typeof import('../web/src/lib/chat.ts') & typeof import('../web/src/lib/comments.ts') & typeof import('../web/src/lib/waiting.ts') & typeof import('../web/src/lib/board.ts')} Lib */
export const lib = /** @type {Lib} */ ({});
/** @template {{ [K in keyof Lib]: Lib[K] extends (...a: any[]) => any ? K : never }[keyof Lib]} K @param {K} name @returns {Lib[K]} */
export const moved = name => /** @type {any} */ ((...a) => /** @type {any} */ (lib[name])(...a));
export const ago = moved('ago'); // moved: web/src/lib/time.ts
export const syncClock = moved('syncClock'); // moved: web/src/lib/time.ts
export const runOutIn = moved('runOutIn'); // moved: web/src/lib/limits.ts
export const limitView = moved('limitView'); // moved: web/src/lib/limits.ts
export const prLabel = moved('prLabel'); // moved: web/src/lib/forge.ts
export const lead = moved('lead'); // moved: web/src/lib/text.ts
export const openDecision = moved('openDecision'); // moved: web/src/lib/chat.ts
export const freshComments = moved('freshComments'); // moved: web/src/lib/comments.ts
export const authorSummary = moved('authorSummary'); // moved: web/src/lib/comments.ts
export const waitsOnYou = moved('waitsOnYou'); // moved: web/src/lib/waiting.ts

// The composer and the question cards are islands (web/src/islands/Composer.vue, Ask.vue). `composer` is what the old
// chat code tells them (turn, ask, boot, wait: what a refresh found) and asks of them (send),
// set by their composables when web/dist/main.js loads. `push` is app.js's notification state, shown in the + menu.
/**
 * @type {{
 *   turn: (data: (Partial<Transcript> & { error?: boolean }) | null) => void,
 *   endDiscuss: () => void,
 *   ask: (s: Session, data: Transcript) => Promise<void>,
 *   boot: (tmux: string | null | undefined) => Promise<void>,
 *   wait: (s: Session | null, data: Transcript | null, items: ChatItem[]) => void,
 *   send: (sid: string, text: string, answerTo?: string, note?: string, canned?: boolean, once?: string) => Promise<boolean> }}
 */
export const composer = { turn: () => {}, endDiscuss: () => {}, ask: async () => {}, boot: async () => {}, wait: () => {}, send: async () => false };
/** Desktop notifications asked for in this browser (the bell) and allowed by it. */
export const notifyOn = () => store.get('notify') === '1' && window.Notification?.permission === 'granted';
export const push = { label: 'Enable notifications on this device', state: '' };

/** @param {{ project: string }} x */
export const isTracked =x => state.tracked.includes(x.project);
// In a tracked project and in the selected one (or "All").
/** @param {{ project: string }} x */
export const inView = x => isTracked(x) && (state.project === 'all' || x.project === state.project);
/** @returns {Session[]} */
export const visibleSessions = () => state.sessions.filter(inView);
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
/** @param {WorkItem} x */
const newCount = x => (x.pr ? freshComments(x.comments, seenAt(x.pr)).length : 0);
// The Work count (the board's title and the phone's Work button): the Needs you rows the board shows now, set by list.js.
/** @param {number} n */
export function setWorkCount(n) {
    for (const badge of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.work-n'))) {
        badge.textContent = String(n);
        badge.hidden = !n;
    }
}
// Counts every tracked project, not only the selected one: the tab title is how another project's waiting chat gets seen.
export function updateTitle() {
    const tracked = state.sessions.filter(isTracked);
    // the chat's own poll can see its question before the session list does; max, so it isn't counted twice
    const asking = Math.max(tracked.filter(waitsOnYou).length, state.asking ? 1 : 0);
    const n = tracked.flatMap(s => s.items || []).filter(x => x.column === 'needs-you' || x.column === 'ready' || newCount(x)).length + asking;
    document.title = n ? `(${n}) Homebase` : 'Homebase';
}

