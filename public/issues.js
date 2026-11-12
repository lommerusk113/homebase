// Issues tab: the selected milestone's open issues in one lane per person (you first, then A–Z, then Unassigned).
// Read-only towards GitLab; "Send to chat" only types into the bound chat session. Draws from milestone.js's /api/milestones data.
import { $, el, ago, prChip, tooltip, waButton, store, hooks } from './core.js';
import { ciPill } from './list.js';
import { chatSession, sendText } from './chat.js';

export const STATES = { doing: 'in progress', closable: 'can be closed', todo: 'not started', free: 'unassigned' };

// Open issues as cards with their state, in lane order: in progress, can be closed, not started, unassigned.
export function issueCards(groups) {
    return [['doing', 'doing'], ['closable', 'closable'], ['assigned', 'todo'], ['unassigned', 'free']]
        .flatMap(([g, st]) => groups[g].map(i => ({ ...i, st })));
}

// Who a card belongs to: its assignees, else the authors of its MRs (an in-progress issue nobody assigned).
export function owners(card) {
    if (card.assignees.length) return card.assignees;
    return [...new Map(card.mrs.filter(m => m.author).map(m => [m.author.username, m.author])).values()];
}

// Lanes [{ who: { name, username } | null, me, list, closed }]: you first, others by name, Unassigned last (always there).
// done: the milestone's closed issues, counted per assignee.
export function buildLanes(cards, done, me) {
    const lanes = new Map();
    for (const c of cards) {
        for (const p of owners(c)) {
            if (!lanes.has(p.username)) lanes.set(p.username, { who: p, me: p.username === me?.username, list: [], closed: 0 });
            lanes.get(p.username).list.push(c);
        }
    }
    const free = { who: null, me: false, list: cards.filter(c => !owners(c).length), closed: 0 };
    for (const i of done) {
        if (!i.assignees.length) free.closed++;
        for (const p of i.assignees) if (lanes.has(p.username)) lanes.get(p.username).closed++;
    }
    return [...[...lanes.values()].sort((a, b) => b.me - a.me || a.who.name.localeCompare(b.who.name)), free];
}

// Closed issues per assignee for the folded Closed line: [[name, n]] by name, unassigned last.
export function closedBy(done) {
    const n = new Map();
    for (const i of done) for (const k of i.assignees.length ? i.assignees.map(p => p.name) : ['unassigned']) n.set(k, (n.get(k) ?? 0) + 1);
    return [...n].sort((a, b) => (a[0] === 'unassigned') - (b[0] === 'unassigned') || a[0].localeCompare(b[0]));
}

// What "Send to chat" types: start a not-started issue, or check on one with an MR (its open MR first).
export function chatMessage(card) {
    const mr = card.mrs.find(m => m.state === 'open') ?? card.mrs[0];
    return mr ? `Check on #${card.iid} and !${mr.iid}` : `Implement #${card.iid}`;
}

// "Supplier automation: undo in the grid" -> "undo in the grid" when the prefix is the milestone's name.
export const shortTitle = (title, milestone) => {
    const m = title.match(/^([^:]{1,60}):\s+(.+)$/);
    return m && m[1].toLowerCase().startsWith(milestone.toLowerCase()) ? m[2] : title;
};

const COLOURS = ['#0969da', '#8250df', '#1a7f37', '#9a6700', '#bf3989', '#0a7b83'];
const first = n => n.split(' ')[0];
const initials = n => n.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();

let data, openIid = null, closedOpen = false;
const sentAt = new Map(); // iid -> last send, so a re-render keeps the button showing it

// Tabs: Work (the item list) and Issues. 1 and 2 switch (keys.js); the choice survives reloads.
export function showTab(tab) {
    tab = tab === 'issues' ? 'issues' : 'work';
    store.set('tab', tab);
    for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', b.dataset.tab === tab);
    $('masters').hidden = tab !== 'work';
    $('issues').hidden = tab !== 'issues';
}
export const activeTab = () => ($('issues').hidden ? 'work' : 'issues');

// Grey placeholder lanes while the issues load: three lanes of a few cards.
function skeleton() {
    return [0, 1, 2].map(n => {
        const sec = el('section', 'lane skel'), side = el('div', 'who'), strip = el('div', 'strip');
        side.append(el('i', 'bone'), el('i', 'bone short'));
        strip.append(...Array.from({ length: 3 - n }, () => el('i', 'bone card')));
        sec.append(side, strip);
        return sec;
    });
}

const NO_GROUPS = { closable: [], doing: [], assigned: [], unassigned: [], done: [] };

// d: an /api/milestones response, null for "All my projects", undefined while the project's first response loads.
// A selected milestone without groups is still loading its issues (the counts are already there).
export function renderIssues(d = data) {
    data = d;
    const badge = $('tab-free'), free = d?.selected?.groups?.unassigned.length ?? 0;
    badge.hidden = !free; badge.textContent = `${free} unassigned`;
    const pane = $('issues'), hadFocus = pane.contains(document.activeElement);
    const ms = d?.selected;
    if (d === undefined || ms?.loading) {
        pane.replaceChildren(...(ms ? [head({ ...ms, groups: NO_GROUPS }, 'Loading issues…')] : []), ...skeleton());
        pane.setAttribute('aria-busy', 'true');
        return;
    }
    pane.removeAttribute('aria-busy');
    if (!ms?.groups) {
        pane.replaceChildren(el('div', 'welcome', d === null ? 'Pick a project in the header to see its milestone issues.'
            : ms?.error ? `Could not load the issues: ${ms.error}` : 'Pick a milestone in the header pill to see its issues.'));
        return;
    }
    const cards = issueCards(ms.groups);
    pane.replaceChildren(head(ms, d.updating && 'Updating…'), ...buildLanes(cards, ms.groups.done, d.me).map((l, n) => lane(l, n, ms)), closedLine(ms.groups.done),
        el('div', 'is-note', 'Read-only: Homebase never writes to GitLab. "Send to chat" only types into the chat on the right.'));
    hooks.rendered?.(hadFocus);
}

// hint: "Loading issues…" or "Updating…" next to the title, with a spinner.
function head(ms, hint) {
    const g = ms.groups, open = ms.total - ms.closed, h = el('div', 'is-head');
    const title = el('div', 'is-title'), gl = el('a', null, 'GitLab ↗');
    gl.href = ms.url; gl.target = '_blank'; gl.rel = 'noopener';
    title.append(el('b', null, `⚑ ${ms.title}`), gl);
    if (hint) {
        const s = el('span', 'is-hint');
        s.append(el('wa-spinner'), hint);
        title.append(s);
    }
    const big = el('div', 'is-big', `${open} open `);
    big.append(el('small', null, `of ${ms.total}`));
    const segs = [[ms.closed, '--c-ready', 'closed'], [g.closable.length, '--c-ready', 'can be closed'], [g.doing.length, '--c-doing', 'in progress'],
        [g.assigned.length, '--c-idle', 'not started'], [g.unassigned.length, '--c-needs', 'unassigned']];
    const bar = el('div', 'is-bar'), legend = el('div', 'is-legend');
    for (const [n, c, label] of segs) {
        if (!n) continue;
        const i = el('i'); i.style.flex = n; i.style.background = `var(${c})`; bar.append(i);
        const s = el('span'); s.style.setProperty('--c', `var(${c})`); s.append(el('i', 'sw'), `${n} ${label}`); legend.append(s);
    }
    const mid = el('div'); mid.append(bar, legend);
    const due = el('div', 'is-due');
    if (ms.due) due.append('due ', el('b', null, new Date(ms.due + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })));
    else due.append(el('b', null, 'No due date'));
    h.append(title, big, mid, due);
    return h;
}

function lane({ who, me, list, closed }, n, ms) {
    const sec = el('section', 'lane' + (who ? '' : ' free')), side = el('div', 'who'), name = el('div', 'name');
    const av = el('span', 'av', who ? initials(who.name) : '?');
    if (who) av.style.background = COLOURS[n % COLOURS.length];
    name.append(av, who ? first(who.name) : 'Unassigned');
    if (who) name.title = `${who.name} (@${who.username})`;
    if (me) name.append(el('span', 'you', 'you'));
    const count = st => list.filter(c => c.st === st).length;
    const parts = who ? [['doing', 'in progress'], ['closable', 'can close'], ['todo', 'not started'], ['free', 'unassigned']].map(([st, l]) => count(st) && `${count(st)} ${l}`).filter(Boolean)
        : [`${list.length} up for grabs`];
    side.append(name, el('small', null, parts.join(' · ') || 'nothing open'), el('small', null, `${closed} closed`));
    const strip = el('div', 'strip');
    strip.append(...(list.length ? list.map(c => card(c, ms)) : [el('span', 'empty', 'Nothing up for grabs.')]));
    sec.append(side, strip);
    return sec;
}

function card(c, ms) {
    const open = openIid === c.iid, a = el('article', `card ${c.st}${open ? ' open' : ''}`);
    a.dataset.key = `issue:${c.iid}`; a.dataset.url = c.url;
    a.setAttribute('aria-expanded', open);
    const top = el('div', 'top');
    top.append(el('span', 'mono', `#${c.iid}`), el('span', 'st', STATES[c.st]), el('span', 'age', c.updated ? ago(Date.parse(c.updated)) : ''));
    if (c.updated) top.lastChild.title = `Updated ${new Date(c.updated).toLocaleString()}`;
    const ft = el('div', 'ft');
    for (const m of c.mrs) ft.append(prChip({ pr: m.url }), ...ciPill(m.pipeline));
    if (!c.mrs.length) ft.append(el('span', 'chip', 'no MR'));
    a.append(top, el('div', 'tt', open ? c.title : shortTitle(c.title, ms.title)), ft);
    if (!open) a.title = c.title;
    if (open) a.append(more(c));
    a.onclick = () => { openIid = open ? null : c.iid; renderIssues(); };
    return a;
}

function more(c) {
    const box = el('div', 'more'), msg = chatMessage(c), acts = el('div', 'acts');
    if (c.desc) box.append(el('div', 'desc', c.desc));
    const sent = Date.now() - (sentAt.get(c.iid) ?? 0) < 3000;
    const send = waButton(sent ? 'Sent ✓' : 'Send to chat', null, { variant: 'brand', appearance: 'filled', ...(sent || !chatSession() ? { disabled: true } : {}) });
    send.onclick = e => {
        e.stopPropagation();
        const s = chatSession();
        if (!s || Date.now() - (sentAt.get(c.iid) ?? 0) < 3000) return;
        sentAt.set(c.iid, Date.now()); renderIssues(); setTimeout(() => renderIssues(), 3000);
        sendText(s.id, msg);
    };
    const note = el('span', 'msg', 'sends '); note.append(el('code', null, msg));
    const gl = el('a', 'gl', 'Open in GitLab ↗'); gl.href = c.url; gl.target = '_blank'; gl.rel = 'noopener';
    acts.append(send, tooltip(send, chatSession() ? `Types "${msg}" into the chat on the right` : 'No chat session to send to'), note, gl);
    box.append(acts);
    box.onclick = e => e.stopPropagation();
    return box;
}

function closedLine(done) {
    const d = el('details', 'is-closed'), s = el('summary');
    s.append(el('b', null, `Closed · ${done.length}`), el('span', null, closedBy(done).map(([who, n]) => `${who === 'unassigned' ? who : first(who)} ${n}`).join(' · ')));
    const chips = el('div', 'chips');
    chips.append(...done.map(i => { const a = el('a', 'chip', `#${i.iid} ${i.title}`); a.href = i.url; a.target = '_blank'; a.rel = 'noopener'; a.title = i.title; return a; }));
    d.append(s, chips);
    d.open = closedOpen;
    d.ontoggle = () => { closedOpen = d.open; };
    return d;
}

// Esc in the Issues tab folds the open card; false when there was none.
export function collapseIssue() {
    if (openIid == null) return false;
    openIid = null; renderIssues();
    return true;
}
