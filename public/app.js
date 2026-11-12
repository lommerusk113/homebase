// Entry point: header (project select, bell, projects dialog), polling, notifications, limits strip.
import { $, el, state, store, saveTracked, shown, updateTitle, prLabel, waButton, ago } from './core.js';
import { renderBoard, select, attentionEvents } from './list.js';
import { refreshChat, initChat } from './chat.js';
import { mountMilestones } from './milestone.js';

// Web Awesome's dark theme is a class; follow the OS like the rest of the page does.
const dark = matchMedia('(prefers-color-scheme: dark)');
const syncTheme = () => document.documentElement.classList.toggle('wa-dark', dark.matches);
dark.addEventListener('change', syncTheme); syncTheme();

// Rebuild options only when they changed, and never while the list is open: the open listbox would lose its options.
function fillSelect(sel, opts, value) {
    if (sel.open) return;
    const now = [...sel.querySelectorAll('wa-option')];
    if (!(now.length === opts.length && now.every((o, i) => o.value === opts[i][0] && o.textContent === opts[i][1]))) {
        sel.replaceChildren(...opts.map(([v, t]) => { const o = el('wa-option', null, t); o.setAttribute('value', v); return o; }));
    }
    if (sel.value !== value) sel.value = value;
}

const counts = () => { const c = {}; for (const s of state.sessions) c[s.project] = (c[s.project] || 0) + 1; return c; };

function renderProjects() {
    if (state.project !== 'all' && !state.tracked.includes(state.project)) state.project = 'all';
    const names = [...state.tracked].sort((a, b) => a.localeCompare(b));
    fillSelect($('project'), [['all', 'All my projects'], ...names.map(n => [n, n])], state.project);
}

function renderDialog() {
    const c = counts(), body = $('dlg-body');
    const row = (name, kind) => {
        const r = el('div', 'p-row'), b = waButton(kind === 'add' ? '+ Add' : 'Remove', kind);
        r.append(el('span', null, name), el('small', null, `${c[name] || 0} sessions`), b);
        b.onclick = () => {
            state.tracked = kind === 'add' ? [...state.tracked, name] : state.tracked.filter(p => p !== name);
            saveTracked(); renderDialog(); renderProjects(); renderBoard();
        };
        return r;
    };
    const others = Object.keys(c).filter(p => !state.tracked.includes(p)).sort((a, b) => c[b] - c[a]);
    body.replaceChildren(
        el('h4', null, 'On board'),
        ...(state.tracked.length ? [...state.tracked].sort().map(p => row(p, 'rm')) : [el('div', 'd-empty', 'None yet.')]),
        el('h4', null, 'Seen in recent sessions'),
        ...(others.length ? others.map(p => row(p, 'add')) : [el('div', 'd-empty', 'Nothing else found.')])
    );
}
$('manage').onclick = () => { renderDialog(); $('dlg').open = true; };

// Projects are named after their git repo now; map saved names that were folder names (e.g. codetool → homebase).
function migrateTracked() {
    const folder = s => (s.cwd || '').replace(/\/\.(claude\/)?worktrees\/.*$/, '').split('/').pop();
    const rename = n => state.sessions.some(s => s.project === n) ? n : (state.sessions.find(s => folder(s) === n)?.project ?? n);
    const tracked = [...new Set(state.tracked.map(rename))];
    if (tracked.join() !== state.tracked.join()) { state.tracked = tracked; saveTracked(); }
    const project = state.project === 'all' ? 'all' : rename(state.project);
    if (project !== state.project) { state.project = project; store.set('project', project); }
}

const notifyOn = () => store.get('notify') === '1' && window.Notification?.permission === 'granted';
function notify({ kind, item: x }) {
    if (!notifyOn() || (document.visibilityState === 'visible' && document.hasFocus())) return;
    const ref = x.pr ? prLabel(x.pr) : x.title;
    const [title, body] = { 'needs-you': [`Needs you: ${x.title} — ${x.next}`], ready: [`Ready to merge: ${ref}`, x.title], finished: [`Agent finished: ${x.title}`, x.column === 'doing' ? undefined : x.next], failing: [`Pipeline failing: ${ref}`, x.title] }[kind];
    const n = new Notification(title, { body, tag: x.key, icon: '/icon.svg' });
    n.onclick = () => {
        window.focus(); n.close();
        const it = state.sessions.flatMap(s => s.items || []).find(i => i.key === x.key);
        if (it && state.selected !== it.key) select(it);
        document.querySelector('.rows tr.sel')?.scrollIntoView({ block: 'center' });
    };
}
const bell = $('bell');
// the off icon is a bell with a slash; on adds an accent dot (styled in styles.css)
const renderBell = () => { const on = notifyOn(); bell.classList.toggle('on', on); bell.setAttribute('aria-pressed', on); };
bell.hidden = !window.Notification;
// permission is only ever requested from this click
bell.onclick = async () => {
    const on = !notifyOn() && await Notification.requestPermission() === 'granted';
    store.set('notify', on ? '1' : '0'); renderBell();
};
if (window.Notification) renderBell();

let lastSessions = '', lastRender = 0;
async function refresh() {
    try {
        const text = await fetch('/api/sessions').then(r => r.text());
        $('offline').hidden = true;
        // ponytail: skip identical re-renders so text in an open detail stays selectable; re-render each minute for the ages
        if (text !== lastSessions || Date.now() - lastRender > 60_000) {
            state.sessions = JSON.parse(text);
            migrateTracked();
            lastSessions = text; lastRender = Date.now();
            renderProjects(); renderBoard();
            // diffed over all items, then filtered, so changing the project filter doesn't read as transitions
            const items = state.sessions.flatMap(s => s.items || []);
            attentionEvents(state.items, items).filter(e => shown(e.item)).forEach(notify);
            state.items = items;
        }
        updateTitle();
    } catch { $('offline').hidden = false; }
    refreshChat(); refreshLimits();
}

// "5h 27% used · resets 01:20 · week 36% used · resets Tue 19:00", as Claude Code's /usage counts it; hidden without a dump.
const usedColor = used => (used < 60 ? 'var(--c-ready)' : used < 85 ? 'var(--c-warn)' : 'var(--c-danger)');
async function refreshLimits() {
    let l = null;
    try { l = await fetch('/api/limits').then(r => r.json()); } catch {}
    const box = $('limits'), wins = [['5h', l?.fiveHour, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }], ['week', l?.sevenDay, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }]].filter(([, w]) => w);
    box.hidden = !wins.length;
    box.replaceChildren(...wins.flatMap(([label, w, fmt], i) => {
        const used = Math.min(100, Math.round(w.used)), s = el('span'), bar = el('i'), fill = el('b');
        fill.style.width = `${used}%`; fill.style.background = usedColor(used); bar.append(fill);
        s.title = `Resets ${new Date(w.resetsAt).toLocaleString()}`;
        s.append(label, bar, `${used}% used · resets ${new Date(w.resetsAt).toLocaleString([], fmt)}`);
        return i ? [el('span', 'muted', '·'), s] : [s];
    }));
    // text only, so an open tooltip survives the 3s refresh
    if (l?.updated) { const a = ago(l.updated); $('limits-tip').textContent = a === 'now' ? 'Updated just now' : `Updated ${a} ago`; }
}

const project = $('project');
// catch up on option updates skipped while the list was open (tooltips' wa-after-hide bubble too, hence the target check)
project.addEventListener('wa-after-hide', e => { if (e.target === project) renderProjects(); });
project.addEventListener('change', () => {
    if (!project.value || project.value === state.project) return;
    state.project = project.value; store.set('project', state.project); renderBoard(); refreshChat();
});
document.addEventListener('keydown', e => {
    // Escape that closed the select or the dialog isn't a "deselect the row"
    if (e.key === 'Escape' && state.selected && !e.composedPath().some(n => n.localName === 'wa-select' || n.localName === 'wa-dialog')) { state.selected = null; renderBoard(); }
});

initChat();
mountMilestones($('milestones'), () => state);
refresh(); setInterval(refresh, 3000);
