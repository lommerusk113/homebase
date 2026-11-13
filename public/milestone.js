// Milestone pill for the header: progress of the chosen milestone, a menu to switch it, and the list filter it drives.
// Read-only towards GitLab/GitHub: the menu only links out.
import { api, el, store, link } from './core.js';
const FETCH_MS = 30_000; // the server caches the glab calls; this only bounds how stale the pill gets
const POLL_MS = 3000;
const LOADING_MS = 1000; // while the server is still loading the issues, or refreshing stale ones

const due = d => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');

// Whether a work item stays in the list for the selected milestone ({ id } or null): items with an MR of that
// milestone, plus items without an MR (running or stopped agents). No selection keeps everything.
/** @param {WorkItem} item @param {{ id: number } | null} selected */
export function inMilestone(item, selected) {
    return !selected || !item.pr || item.milestone?.id === selected.id;
}

// Small tag for a work-item row whose MR belongs to a milestone (item.milestone { id, title } comes from the server).
/** @param {WorkItem} item */
export function milestoneTag(item) {
    if (!item?.milestone) return null;
    const t = el('span', 'chip ms-tag', `⚑ ${item.milestone.title}`);
    t.title = `Milestone: ${item.milestone.title}`;
    return t;
}

// Pill text and tooltip for a selected milestone (groups from the server's groupIssues): "11 open", the full breakdown in the tooltip.
// Before the server has the issues (ms.loading, no groups) the counts come from the milestone list.
/** @param {SelectedMilestone} ms @returns {{ text: string, tip: string }} */
export function pillLabel(ms) {

    const g = ms.groups, open = ms.total - ms.closed;
    if (!g) return { text: ms.total == null ? 'loading…' : `${open} open`, tip: `${ms.title}: loading issues… · ${due(ms.due)}` };
    const parts = [[g.doing, 'in progress'], [g.closable, 'can be closed'], [g.assigned, 'not started'], [g.unassigned, 'unassigned']]
        .filter(([l]) => l.length).map(([l, label]) => `${l.length} ${label}`);

    return { text: `${open} open`, tip: `${ms.title}: ${open} open of ${ms.total}${parts.length ? ` (${parts.join(', ')})` : ''}, ${ms.closed} closed · ${due(ms.due)}` };
}

// An /api/milestones answer (status, body) as the pill's data. A body without a milestone list (a bare 500 from an
// older server, a proxy page) becomes the error state, so the pill never waits on it.
/** @param {number} status @param {string} text @param {string} [project] @returns {Milestones} */
export function toData(status, text, project = '') {
    try {
        const d = JSON.parse(text);
        if (Array.isArray(d?.milestones)) return d;
    } catch {}
    return { project, milestones: [], detected: [], me: null, selected: null, updating: false, loading: false, reason: 'error', error: text.trim() || `HTTP ${status}`, url: null };
}

// Whether to poll fast: the issues still load or a refresh runs. A reason (none, error, unsupported) is final.
/** @param {Milestones} d */
export const isLoading = d => !d.reason && !!(d.selected?.loading || d.updating);

// Pill text and tooltip for a project without milestones to show (data.reason), null otherwise.
/** @param {Milestones} d @returns {{ text: string, tip: string, err: boolean } | null} */
export function emptyPill(d) {
    if (!d.reason) return null;
    if (d.reason === 'none') return { text: 'No milestones', tip: `No open milestones in ${d.project}`, err: false };
    return { text: 'Milestones unavailable', tip: `${d.error ?? d.reason}\nRefresh (r) to retry`, err: true };
}

// The header pill for one project: "⚑ Supplier automation · 11 open" with a mini bar; its menu switches milestones.
// The element polls /api/milestones itself while it is in the page and stops once removed.
// onChange({ id, title } | null) runs when the selected milestone is known or changes. The choice is kept per project.
// onData(response) runs with every changed /api/milestones response (the Issues tab draws from it).
// onBusy(true|false) runs when a picked milestone starts and stops loading, so a view can dim its old data.
/**
 * @param {string} project
 * @param {{ onChange?: (m: { id: number, title: string } | null) => void, onData?: (d: Milestones) => void, onBusy?: (busy: boolean) => void }} [opts]
 */
export function milestoneSelector(project, { onChange, onData, onBusy } = {}) {
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

    /** @param {Milestones} data */
    function render(data) {
        const ms = data.selected, empty = emptyPill(data);
        pick.classList.toggle('off', !!empty);
        pick.classList.toggle('err', !!empty?.err);
        if (empty) {
            summary.replaceChildren(el('span', null, '⚑'), el('span', null, empty.text));
            summary.title = empty.tip;
            const info = el('div', 'info', empty.err ? `${empty.tip.replace('\n', '. ')}.` : empty.tip);
            menu.replaceChildren(info);
            if (data.url) info.append(link(null, 'Milestones page ↗', data.url));
            return;
        }
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
            b.dataset.id = String(m.id);
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
        else if (seen) { clearInterval(timer); document.removeEventListener('click', outside); document.removeEventListener('homebase:refresh', now); return; }
        const want = store.get(key) ?? '';
        if (pending || (want === asked && Date.now() - at < (loading ? LOADING_MS : FETCH_MS))) return;
        pending = true;
        let ok = false;
        try {
            const r = await api(`/api/milestones?project=${encodeURIComponent(project)}&milestone=${encodeURIComponent(want)}`);
            const text = JSON.stringify(toData(r.status, await r.text(), project));
            ok = true;
            if (busy === want) setBusy(null);
            if (text && text !== json) { // redraw only on change, so an open menu stays put
                json = text;
                const data = /** @type {Milestones} */ (JSON.parse(text));
                loading = isLoading(data);
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
    // the refresh button: fetch now instead of waiting out FETCH_MS
    const now = () => { at = 0; tick(); };
    document.addEventListener('homebase:refresh', now);
    tick();
    return pick;
}
