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

export const $ = id => document.getElementById(id);
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
// Web Awesome button; attributes rather than properties so it works before the element is upgraded.
export const waButton = (text, cls, attrs = {}) => {
    const b = el('wa-button', cls, text);
    for (const [k, v] of Object.entries({ size: 'small', appearance: 'outlined', ...attrs })) b.setAttribute(k, v === true ? '' : v);
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

// Plug-in point for list filters: app.js sets hooks.inMilestone to milestone.js's inMilestone(item, selected).
export const hooks = { inMilestone: () => true };

export const visibleSessions = () => state.sessions.filter(s => state.tracked.includes(s.project) && (state.project === 'all' || s.project === state.project));
export const shown = x => state.tracked.includes(x.project) && (state.project === 'all' || x.project === state.project);
export function updateTitle() {
    const n = visibleSessions().flatMap(s => s.items || []).filter(x => x.column === 'needs-you' || x.column === 'ready').length + (state.asking ? 1 : 0);
    document.title = n ? `(${n}) Homebase` : 'Homebase';
}
