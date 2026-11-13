// Shared state and DOM helpers. No DOM access at import time, so node can import the modules that use it.
// marked and DOMPurify are globals from index.html's <script> tags.

export const COLUMNS = [
    { key: 'needs-you', label: 'Needs you', color: '--c-needs' },
    { key: 'doing', label: 'Doing', color: '--c-doing' },
    { key: 'review', label: 'In review', color: '--c-review' },
    { key: 'ready', label: 'Ready to merge', color: '--c-ready' },
    { key: 'done', label: 'Merged', color: '--c-done' }
];
export const COL = Object.fromEntries(COLUMNS.map(c => [c.key, c]));
export const LIFECYCLE = ['Implement', 'Verify', 'Review', 'Approved', 'Merged'];

export const store = { get: k => { try { return window.localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { window.localStorage.setItem(k, v); } catch {} } };
const parse = v => { try { return JSON.parse(v) || []; } catch { return []; } };
// ponytail: tracked list lives in this browser's localStorage; move to a projects.json if you want it across browsers
export const state = { sessions: [], tracked: parse(store.get('tracked')), project: store.get('project') || 'all', selected: null, chat: store.get('chat'), unfold: new Set(), outbox: [], nudged: new Set() };
export const saveTracked = () => { store.set('tracked', JSON.stringify(state.tracked)); };

// Every API call goes through here: the per-start token from index.html's meta tag, plus x-codetool on POSTs.
// A 401 means the server restarted with a new token: read it from a fresh index.html (one fetch shared by concurrent
// callers) and retry once. A 401 is rejected before any handler runs, so retrying a POST can't double-send.
// Never reloads, so typed text and UI state survive; a second 401 goes back to the caller, which shows the offline
// state and keeps polling.
export const page = { token: null, build: null, updated: false };
const metaOf = (html, name) => html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`))?.[1];
const ownMeta = name => globalThis.document?.querySelector(`meta[name="${name}"]`)?.content ?? null;
let refreshing = null;
export function refreshToken() {
    return refreshing ??= fetch('/', { cache: 'no-store' })
        .then(r => (r.ok ? r.text() : ''))
        .then(html => {
            const token = metaOf(html, 'homebase-token'), build = metaOf(html, 'homebase-build');
            if (token) page.token = token;
            page.build ??= ownMeta('homebase-build');
            // new code under a running page: say so in the header, never reload on our own
            if (build && page.build && build !== page.build && !page.updated) {
                page.updated = true;
                globalThis.document?.getElementById('updated')?.removeAttribute('hidden');
            }
            return page.token;
        })
        .catch(() => page.token)
        .finally(() => { refreshing = null; });
}
export async function api(path, opts = {}) {
    page.token ??= ownMeta('homebase-token');
    const send = token => fetch(path, { ...opts, headers: { ...opts.headers, 'x-homebase-token': token, ...(opts.method === 'POST' && { 'x-codetool': '1' }) } });
    const used = page.token, r = await send(used);
    if (r.status !== 401) return r;
    const token = page.token !== used ? page.token : await refreshToken(); // another caller may have the new one already
    return token && token !== used ? send(token) : r;
}

export const $ = id => document.getElementById(id);
// Failed poll (network, 401, non-OK): header "Offline", list dimmed with its "Disconnected" note. The next good poll clears it.
export const setOffline = off => { state.offline = off; $('offline').hidden = !off; document.body.classList.toggle('disconnected', off); };
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// Web Awesome button; attributes rather than properties so it works before the element is upgraded.
export const waButton = (text, cls, attrs = {}) => {
    const b = el('wa-button', cls, text);
    for (const [k, v] of Object.entries({ size: 's', appearance: 'outlined', ...attrs })) b.setAttribute(k, v === true ? '' : v);
    return b;
};
// A <wa-tooltip> for target (given an id if it has none); the caller places it next to the target.
let tipCount = 0;
export const tooltip = (target, text) => {
    target.id ||= `tip-${++tipCount}`;
    const t = el('wa-tooltip', null, text);
    t.setAttribute('for', target.id);
    return t;
};

export const plain = t => (t || '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
export const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 60 ? 'now' : s < 3600 ? `${s / 60 | 0}m` : s < 86400 ? `${s / 3600 | 0}h` : `${s / 86400 | 0}d`; };
// Rate-limit window -> % left and time to reset, as Contado's footer shows it: "70%" and "1h20m" / "4d22h" / "45m".
export const limitLeft = (w, now = Date.now()) => {
    const m = Math.max(0, w.resetsAt - now) / 60000 | 0, d = m / 1440 | 0, h = m % 1440 / 60 | 0;
    return { left: Math.max(0, Math.min(100, Math.round(100 - w.used))), until: d ? `${d}d${h ? h + 'h' : ''}` : h ? `${h}h${m % 60 ? m % 60 + 'm' : ''}` : `${m}m` };
};
// Chat status bar: a failed poll wins (never claim "Idle" on data we couldn't fetch), then asking over working
// (Claude waits on you); working counts from your last message.
export const chatStatus = (d, now = Date.now()) => {
    if (d?.error) return { kind: 'error', text: 'Can’t reach Homebase — reconnecting…' };
    if (d?.asking) return { kind: 'asking', text: 'Claude is asking — answer below' };
    if (!d?.working) return { kind: 'idle', text: 'Idle — waiting for you' };
    const at = Date.parse(d.items?.findLast(i => i.role === 'user' && !i.pending)?.at), m = (now - at) / 60000 | 0;
    return { kind: 'working', text: `Claude is working…${m > 0 ? ` · ${m < 60 ? m + 'm' : `${m / 60 | 0}h${m % 60 ? m % 60 + 'm' : ''}`}` : ''}` };
};
// Limits strip item: "Session 70%" at a glance, details in the tooltip; the countdown shows inline only once under 20% is left.
export const limitView = (week, w, now = Date.now()) => {
    const { left, until } = limitLeft(w, now), at = new Date(w.resetsAt), pad = n => String(n).padStart(2, '0');
    const when = `${week ? at.toLocaleDateString('en-US', { weekday: 'short' }) + ' ' : ''}${pad(at.getHours())}:${pad(at.getMinutes())}`;
    return {
        label: week ? 'Week' : 'Session', left,
        text: `${left}%${left < 20 ? ` · resets ${until}` : ''}`,
        tip: `${left}% left of your ${week ? 'weekly' : '5-hour'} limit · resets in ${until} (${when})`,
    };
};
export const prLabel = url => { const m = url.match(/merge_requests\/(\d+)/) || url.match(/pull\/(\d+)/); return m ? (url.includes('merge_requests') ? '!' : '#') + m[1] : 'PR'; };
export const prChip = s => { const a = el('a', 'chip mono', `${prLabel(s.pr)}${s.prState ? ' · ' + s.prState.state : ''}`); a.href = s.pr; a.target = '_blank'; a.onclick = e => e.stopPropagation(); return a; };

// Scan aids on rendered markdown: PR/MR links become chips, !123/#123 become chips, file paths become inline code.
const PR_HREF = /^https:\/\/\S+?\/(?:-\/merge_requests|pull)\/\d+\/?$/;
const TOKEN = /(^|[\s(\[])((?:~|\.{1,2})?\/[\w.@+-]+(?:\/[\w.@+-]+)+\/?|[\w.@+-]+(?:\/[\w.@+-]+)+\.[a-z]\w{0,5}|[!#]\d+\b)/gi;
function enrich(root) {
    for (const a of root.querySelectorAll('a')) {
        a.target = '_blank'; a.rel = 'noopener';
        if (PR_HREF.test(a.href) && a.textContent.startsWith('http')) { a.textContent = prLabel(a.href); a.className = 'chip mono'; a.title = a.href; }
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
        const t = n.textContent;
        if (!t.match(TOKEN)) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        for (const m of t.matchAll(TOKEN)) {
            const start = m.index + m[1].length, tok = m[2].replace(/[.,:;]+$/, '');
            frag.append(t.slice(last, start), /^[!#]/.test(tok) ? el('span', 'chip mono', tok) : el('code', null, tok));
            last = start + tok.length;
        }
        frag.append(t.slice(last));
        n.replaceWith(frag);
    }
    return root;
}
export const rich = (text, inline) => { const d = el('div', inline ? 'lead' : 'body'); d.innerHTML = DOMPurify.sanitize(inline ? marked.parseInline(text) : marked.parse(text || '')); return enrich(d); };

// First sentence of a message without a TLDR, capped near 200 chars, with dangling ** or ` closed.
export function lead(text) {
    const line = (text || '').split('\n').map(l => l.trim()).find(l => l && !/^(```|\||---|<)/.test(l)) || '';
    const s = line.replace(/^(#+|[-*+>]|\d+[.)])\s+/, '');
    let cut = s.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? s;
    const long = cut.length > 200;
    if (long) cut = cut.slice(0, 200).replace(/\s+\S*$/, '');
    if ((cut.match(/\*\*/g)?.length ?? 0) % 2) cut += '**';
    if ((cut.match(/`/g)?.length ?? 0) % 2) cut += '`';
    return long ? cut + '…' : cut;
}
// Collapsed: only the TLDR (or the lead sentence). Show more reveals the rest; open state survives re-renders via state.unfold.
export function foldable(tldr, rest, key) {
    const head = tldr || lead(rest), more = tldr || rest?.trim() !== head ? rest?.trim() : '';
    const top = rich(head, true);
    if (!more) return [top];
    const body = rich(more), btn = el('button', 'show');
    const set = open => { body.hidden = !open; if (!tldr) top.hidden = open; btn.textContent = open ? 'Show less' : 'Show more'; };
    set(state.unfold.has(key));
    btn.onclick = e => { e.stopPropagation(); const open = !state.unfold.has(key); open ? state.unfold.add(key) : state.unfold.delete(key); set(open); };
    return [top, body, btn];
}

// Plug-in points: app.js sets hooks.inMilestone to milestone.js's inMilestone(item, selected), and hooks.refresh for keys.js's r.
export const hooks = { inMilestone: () => true, refresh: () => {} };

export const visibleSessions = () => state.sessions.filter(s => state.tracked.includes(s.project) && (state.project === 'all' || s.project === state.project));
export const shown = x => state.tracked.includes(x.project) && (state.project === 'all' || x.project === state.project);
// "Since last checked" per MR: seen:<mrUrl> in localStorage. An MR never seen before counts as seen now, so the first load doesn't flood.
export const seenAt = pr => { const v = Number(store.get(`seen:${pr}`)); if (v) return v; const now = Date.now(); store.set(`seen:${pr}`, now); return now; };
export const markSeen = (pr, at = Date.now()) => store.set(`seen:${pr}`, at);
export const freshComments = (c, seen) => (c?.items ?? []).filter(i => Date.parse(i.at) > seen);
const firstName = n => n.split(/\s+/)[0];
// "Børre" / "Børre, Ann" / "Børre, Ann +1": distinct first names, at most two
export const authorSummary = items => { const n = [...new Set(items.map(i => firstName(i.author)))]; return n.slice(0, 2).join(', ') + (n.length > 2 ? ` +${n.length - 2}` : ''); };
export const newCount = x => (x.pr ? freshComments(x.comments, seenAt(x.pr)).length : 0);
export function updateTitle() {
    const n = visibleSessions().flatMap(s => s.items || []).filter(x => x.column === 'needs-you' || x.column === 'ready' || newCount(x)).length + (state.asking ? 1 : 0);
    document.title = n ? `(${n}) Homebase` : 'Homebase';
}
