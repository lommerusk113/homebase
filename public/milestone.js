// Milestone pill for the header: progress of the chosen milestone, a menu to switch it, and the list filter it drives.
// Read-only towards GitLab/GitHub: the menu only links out.
import { api } from './core.js';
const FETCH_MS = 30_000; // the server caches the glab calls; this only bounds how stale the pill gets
const POLL_MS = 3000;
const LOADING_MS = 1000; // while the server is still loading the issues, or refreshing stale ones

const CSS = `
  .ms-pick { position:relative; font-size:12.5px; }
  .ms-pick > summary { list-style:none; cursor:pointer; display:inline-flex; align-items:center; gap:6px; padding:2px 10px; border:1px solid var(--line); border-radius:99px; white-space:nowrap; color:var(--fg); }
  .ms-pick > summary::-webkit-details-marker { display:none; }
  .ms-pick > summary:hover { background:var(--hover); }
  .ms-pick > summary .t { font-weight:600; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
  .ms-pick > summary .n { color:var(--muted); }
  .ms-bar { width:40px; height:4px; border-radius:2px; background:var(--line-soft); overflow:hidden; }
  .ms-bar b { display:block; height:100%; background:var(--c-ready); }
  .ms-menu { position:absolute; z-index:20; top:calc(100% + 4px); left:0; width:320px; max-height:70vh; overflow:auto; background:var(--bg); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); padding:6px 0; }
  .ms-menu h5 { margin:6px 12px 4px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
  .ms-menu .info { padding:0 12px 6px; color:var(--muted); display:flex; flex-wrap:wrap; gap:4px 10px; }
  .ms-menu .info a { color:var(--accent); text-decoration:none; }
  .ms-menu .hot { color:var(--c-needs); }
  .ms-menu .chips { display:flex; flex-wrap:wrap; gap:4px; padding:0 12px 6px; }
  .ms-menu .chips a.chip { max-width:100%; background:color-mix(in srgb, var(--c-needs) 16%, var(--bg)); color:var(--c-needs); }
  .ms-menu hr { border:0; border-top:1px solid var(--line-soft); margin:4px 0; }
  .ms-menu button { display:flex; gap:8px; width:100%; text-align:left; appearance:none; border:0; background:none; font:inherit; color:var(--fg); padding:4px 12px; cursor:pointer; }
  .ms-menu button:hover { background:var(--hover); }
  .ms-menu button.on { font-weight:600; }
  .ms-menu button span { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ms-menu button small { color:var(--muted); font-weight:400; }
  .ms-pick wa-spinner { font-size:11px; --track-width:2px; }
  .ms-pick > summary .ld { color:var(--muted); }
  .ms-pick.busy > summary > :not(wa-spinner), .ms-pick.busy .ms-menu > :not(button) { opacity:.5; }
  .ms-menu button wa-spinner { align-self:center; }
  .ms-tag { margin-right:6px; font-size:10.5px; font-weight:500; vertical-align:1px; }
`;

const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const due = d => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');
const link = (cls, text, href) => { const a = el('a', cls, text); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
let styled = false;

// Whether a work item stays in the list for the selected milestone ({ id } or null): items with an MR of that
// milestone, plus items without an MR (running or stopped agents). No selection keeps everything.
export function inMilestone(item, selected) {
    return !selected || !item.pr || item.milestone?.id === selected.id;
}

// Small tag for a work-item row whose MR belongs to a milestone (item.milestone { id, title } comes from the server).
export function milestoneTag(item) {
    if (!item?.milestone) return null;
    const t = el('span', 'chip ms-tag', `⚑ ${item.milestone.title}`);
    t.title = `Milestone: ${item.milestone.title}`;
    return t;
}

// Pill text and tooltip for a selected milestone (groups from the server's groupIssues): "11 open", the full breakdown in the tooltip.
// Before the server has the issues (ms.loading, no groups) the counts come from the milestone list.
export function pillLabel(ms) {

    const g = ms.groups, open = ms.total - ms.closed;
    if (!g) return { text: ms.total == null ? 'loading…' : `${open} open`, tip: `${ms.title}: loading issues… · ${due(ms.due)}` };
    const parts = [[g.doing, 'in progress'], [g.closable, 'can be closed'], [g.assigned, 'not started'], [g.unassigned, 'unassigned']]
        .filter(([l]) => l.length).map(([l, label]) => `${l.length} ${label}`);

    return { text: `${open} open`, tip: `${ms.title}: ${open} open of ${ms.total}${parts.length ? ` (${parts.join(', ')})` : ''}, ${ms.closed} closed · ${due(ms.due)}` };
}

// The header pill for one project: "⚑ Supplier automation · 11 open" with a mini bar; its menu switches milestones.
// The element polls /api/milestones itself while it is in the page and stops once removed.
// onChange({ id, title } | null) runs when the selected milestone is known or changes. The choice is kept per project.
// onData(response) runs with every changed /api/milestones response (the Issues tab draws from it).
// onBusy(true|false) runs when a picked milestone starts and stops loading, so a view can dim its old data.
export function milestoneSelector(project, { onChange, onData, onBusy } = {}) {
    if (!styled) { document.head.append(el('style', null, CSS)); styled = true; }
    const key = `milestone:${project}`, pick = el('details', 'ms-pick'), summary = el('summary'), menu = el('div', 'ms-menu');
    pick.append(summary, menu);
    summary.append(el('span', null, '⚑'), el('span', 'ld', 'Loading…'), el('wa-spinner'));
    summary.title = 'Loading milestones…';
    let json = '', at = 0, asked = null, selectedId, pending = false, seen = false, busy = null, loading = false;

    // the old data stays, dimmed, with a spinner on the pill and on the picked entry until the new milestone's data is in
    const setBusy = v => {
        busy = v;
        pick.classList.toggle('busy', v != null);
        onBusy?.(v != null);
        if (v == null) { pick.querySelectorAll('wa-spinner.picked').forEach(s => s.remove()); return; }
        summary.append(el('wa-spinner', 'picked'));
        menu.querySelector(`button[data-id="${v}"]`)?.append(el('wa-spinner', 'picked'));
    };
    const choose = v => { store.set(key, v); setBusy(v); pick.open = false; tick(); };
    // a details menu doesn't close on outside clicks by itself
    const outside = e => { if (pick.open && !e.composedPath().includes(pick)) pick.open = false; };
    document.addEventListener('click', outside);
    pick.addEventListener('keydown', e => { if (e.key === 'Escape') { pick.open = false; e.stopPropagation(); } });

    function render(data) {
        const ms = data.selected;
        pick.hidden = !data.milestones.length;
        summary.replaceChildren(el('span', null, '⚑'), el('span', 't', ms ? ms.title : 'No milestone'));
        if (ms && !ms.groups) {
            const { text, tip } = pillLabel(ms);
            summary.append(el('span', 'n', `· ${text}`));
            summary.title = tip;
        } else if (ms) {
            const bar = el('span', 'ms-bar'), fill = el('b');
            fill.style.width = `${ms.total ? Math.round(100 * ms.closed / ms.total) : 0}%`;
            bar.append(fill);
            const { text, tip } = pillLabel(ms);
            summary.append(el('span', 'n', `· ${text}`), bar);
            summary.title = tip;
        } else {
            summary.title = 'Show only work items of a milestone';
        }

        if (ms?.loading || data.updating) summary.append(el('wa-spinner'));

        const parts = [];
        if (ms?.loading) parts.push(el('div', 'info', 'Loading issues…'), el('hr'));
        else if (ms?.error) parts.push(el('div', 'info', `Could not load the issues: ${ms.error}`), el('hr'));
        if (ms?.groups) {
            const g = ms.groups, info = el('div', 'info');
            info.append(link(null, due(ms.due), ms.url));
            for (const [k, label] of [['doing', 'in progress'], ['assigned', 'assigned'], ['unassigned', 'unassigned']]) {
                if (g[k].length) info.append(el('span', null, `${g[k].length} ${label}`));
            }
            parts.push(info);
            if (g.closable.length) {
                const chips = el('div', 'chips');
                chips.append(...g.closable.map(i => {
                    const a = link('chip', `#${i.iid} ${i.title}`, i.url);
                    a.title = [i.title, 'Merged, issue still open', ...i.mrs.map(m => `!${m.iid} ${m.state}`)].join('\n');
                    return a;
                }));
                parts.push(el('h5', 'hot', `Can be closed (${g.closable.length})`), chips);
            }
            parts.push(el('hr'));
        }
        parts.push(...data.milestones.map(m => {
            const b = el('button', ms?.id === m.id ? 'on' : null);
            b.dataset.id = m.id;
            b.append(el('span', null, m.title), el('small', null, m.total == null ? '' : `${m.closed}/${m.total}`));
            if (data.detected.includes(m.id)) b.title = 'Your MRs are in this milestone';
            b.onclick = () => choose(String(m.id));
            return b;
        }));
        const none = el('button', ms ? null : 'on');
        none.dataset.id = 'none';
        none.append(el('span', null, 'No milestone'), el('small', null, 'show all'));
        none.onclick = () => choose('none');
        parts.push(none);
        menu.replaceChildren(...parts);
    }

    async function tick() {
        if (pick.isConnected) seen = true;
        else if (seen) { clearInterval(timer); document.removeEventListener('click', outside); return; }
        const want = store.get(key) ?? '';
        if (pending || (want === asked && Date.now() - at < (loading ? LOADING_MS : FETCH_MS))) return;
        pending = true;
        let ok = false;
        try {
            const r = await api(`/api/milestones?project=${encodeURIComponent(project)}&milestone=${encodeURIComponent(want)}`);
            const text = r.ok ? await r.text() : '';
            ok = !!text;
            if (ok && busy === want) setBusy(null);
            if (text && text !== json) { // redraw only on change, so an open menu stays put
                json = text;
                const data = JSON.parse(text);
                loading = !!(data.selected?.loading || data.updating);
                render(data);
                onData?.(data);
                const sel = data.selected ? { id: data.selected.id, title: data.selected.title } : null;
                if (sel?.id !== selectedId) { selectedId = sel?.id; onChange?.(sel); }
            }
        } catch {} finally {
            at = ok ? Date.now() : 0; asked = want; pending = false; // a failed call retries on the next tick
        }
        if (loading) setTimeout(tick, LOADING_MS);
        else if (want !== (store.get(key) ?? '')) tick(); // picked again while this call ran
    }

    const timer = setInterval(tick, POLL_MS);
    tick();
    return pick;
}
