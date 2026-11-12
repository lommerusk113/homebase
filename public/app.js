// Entry point: header (project select, bell, projects dialog), polling, notifications, limits strip.
import { $, el, state, store, saveTracked, shown, updateTitle, prLabel, waButton, ago, limitView, tooltip, hooks } from './core.js';
import { renderBoard, select, attentionEvents } from './list.js';
import { refreshChat, initChat } from './chat.js';
import { milestoneSelector, inMilestone } from './milestone.js';
import { initKeys } from './keys.js';

// One milestone pill for the selected project (none for "All"); it filters the list. Rebuilt only when the project changes.
let pillFor = null, milestone = null;
hooks.inMilestone = x => inMilestone(x, milestone);
function renderMilestone() {
    if (pillFor === state.project) return;
    pillFor = state.project; milestone = null;
    $('milestone-slot').replaceChildren(...(pillFor === 'all' ? [] : [milestoneSelector(pillFor, { onChange: m => { milestone = m; renderBoard(); } })]));
}

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
    renderMilestone();
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

// "Session ▬ 70%   Week ▬ 63%"; reset times live in each item's tooltip. Hidden without a dump.
const leftColor = left => (left >= 50 ? 'var(--c-ready)' : left >= 10 ? 'var(--c-warn)' : 'var(--c-danger)');
async function refreshLimits() {
    let l = null;
    try { l = await fetch('/api/limits').then(r => r.json()); } catch {}
    const box = $('limits'), wins = [l?.fiveHour, l?.sevenDay].map((w, week) => w && limitView(week, w)).filter(Boolean);
    const a = l?.updated && ago(l.updated), updated = !a ? '' : a === 'now' ? 'Updated just now' : `Updated ${a} ago`;
    box.hidden = !wins.length;
    // rebuild only when the set of windows changes, then update in place so an open tooltip survives the 3s refresh
    const key = wins.map(v => v.label).join();
    if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.replaceChildren(...wins.flatMap(() => {
            const s = el('span', 'limit'), bar = el('i');
            bar.append(el('b')); s.append(el('span', 'limit-label'), bar, el('span'));
            return [s, tooltip(s, '')];
        }));
    }
    box.querySelectorAll('.limit').forEach((s, i) => {
        const v = wins[i], [name, bar, val] = s.children;
        name.textContent = v.label; val.textContent = v.text;
        bar.firstChild.style.width = `${v.left}%`; bar.firstChild.style.background = leftColor(v.left);
        s.nextElementSibling.replaceChildren(v.tip, ...(updated ? [el('br'), updated] : []));
    });
}

const project = $('project');
// catch up on option updates skipped while the list was open (tooltips' wa-after-hide bubble too, hence the target check)
project.addEventListener('wa-after-hide', e => { if (e.target === project) renderProjects(); });
project.addEventListener('change', () => {
    if (!project.value || project.value === state.project) return;
    state.project = project.value; store.set('project', state.project); renderMilestone(); renderBoard(); refreshChat();
});
initKeys(); // includes Esc collapsing the expanded row
initChat();
fetch('/api/editors').then(r => r.json()).then(e => { state.editors = e; renderBoard(); }).catch(() => {});
refresh(); setInterval(refresh, 3000);
