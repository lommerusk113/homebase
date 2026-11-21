// Entry point: header (project picker, bell, projects dialog), polling, notifications, limits strip.
import { api, $, el, state, store, saveTracked, isTracked, projectCounts, updateTitle, prLabel, waButton, ago, limitView, runOutIn, tooltip, hooks, page, setOffline, setFormatWarn, seenAt, authorSummary, waitsOnYou } from './core.js';
import { renderBoard, select, attentionEvents, askingEvents, sessionTopic } from './list.js';
import { refreshChat, initChat, bindChat, focusChat, isMaster, chatSession } from './chat.js';
import { openNewProject, initNewProject } from './newproject.js';
import { milestoneSelector, inMilestone } from './milestone.js';
import { initKeys } from './keys.js';
import { picker } from './picker.js';
import { renderIssues, showTab, activeTab } from './issues.js';
import { refreshLog, openLog } from './log.js';

// One milestone pill for the selected project (none for "All"); it filters the list. Rebuilt only when the project changes.
// The old pill stops (timers, in-flight fetch) the moment the project changes; data for another project is dropped.
let pillFor = null, milestone = null, pillStop = new AbortController();
hooks.inMilestone = x => inMilestone(x, milestone);
hooks.milestoneId = () => milestone?.id ?? null;
function renderMilestone() {
    if (pillFor === state.project) {
        return;
    }
    pillStop.abort();
    pillStop = new AbortController();
    pillFor = state.project;
    milestone = null;
    $('issues').classList.remove('stale');
    renderIssues(pillFor === 'all' ? null : undefined);
    if (pillFor === 'all') {
        $('milestone-slot').replaceChildren();
        return;
    }

    const pill = milestoneSelector(pillFor, {
        signal: pillStop.signal,
        onChange: m => {
            milestone = m;
            renderBoard();
        },
        onData: d => {
            if (d.project === state.project) {
                renderIssues(d);
            }
        },
        onBusy: b => $('issues').classList.toggle('stale', b)
    });
    $('milestone-slot').replaceChildren(pill);
}

// Web Awesome's dark theme is a class; follow the OS like the rest of the page does.
const dark = matchMedia('(prefers-color-scheme: dark)');
const syncTheme = () => document.documentElement.classList.toggle('wa-dark', dark.matches);
dark.addEventListener('change', syncTheme);
syncTheme();

/** @returns {Record<string, number>} */
const counts = () => {
    const c = /** @type {Record<string, number>} */ ({});
    for (const s of state.sessions) {
        c[s.project] = (c[s.project] || 0) + 1;
    }
    return c;
};

// One row of the project picker: a dot for the loudest state among its chats, and what they are doing underneath.
/** @param {string} value @param {string} name @param {Session[]} mine @returns {import('./picker.js').PickItem} */
function pickItem(value, name, mine) {
    const chats = mine.filter(s => !s.sidechain);
    const waiting = mine.flatMap(s => s.items || []).filter(x => x.column === 'needs-you').length + mine.filter(waitsOnYou).length; // as projectCounts
    const working = chats.filter(s => s.status === 'working').length;
    const parts = [waiting && `${waiting} waiting on you`, working && `${working} working`, chats.some(s => s.rulesStale) && 'old rules', `${chats.length || 'No'} chat${chats.length === 1 ? '' : 's'}`];

    return { value, name, sub: parts.filter(Boolean).join(' · '), state: waiting ? 'needs' : working ? 'working' : 'idle' };
}

function renderProjects() {
    if (state.project !== 'all' && !state.tracked.includes(state.project)) {
        state.project = 'all';
    }
    const names = [...state.tracked].sort((a, b) => a.localeCompare(b));
    projects.update([pickItem('all', 'All my projects', state.sessions.filter(isTracked)), ...names.map(n => pickItem(n, n, state.sessions.filter(s => s.project === n)))], state.project);
    // the picker button is the one cue for chats waiting in other projects
    const other = state.project === 'all' ? 0 : projectCounts(state.sessions, state.tracked).filter(c => c.project !== state.project).reduce((n, c) => n + c.waiting, 0);
    const pb = $('project');
    pb.dataset.other = other ? String(other) : '';
    pb.setAttribute('aria-label', other ? `Project, ${other} waiting on you in other projects` : 'Project');
    pb.title = other ? `${other} waiting on you in other projects` : 'Switch project (g then p)';
    renderMilestone();
}
/** @param {string} name a tracked project or 'all' */
function setProject(name) {
    if (name === state.project) {
        return;
    }
    state.project = name;
    state.focus = null;
    store.set('project', name);
    renderProjects();
    renderBoard();
    refreshChat();
    refreshLog();
}
hooks.setProject = setProject;
const projects = picker($('project'), {
    onPick: setProject,
    placeholder: 'Filter projects…',
    actions: [['New project…', () => openNewProject()], ['Manage projects…', () => $('manage').click()]]
});
hooks.openProjects = projects.open;

function renderDialog() {
    const c = counts(), body = $('dlg-body');
    const row = (name, kind) => {
        const r = el('div', 'p-row'), b = waButton(kind === 'add' ? '+ Add' : 'Remove', kind);
        r.append(el('span', null, name), el('small', null, `${c[name] || 0} session${c[name] === 1 ? '' : 's'}`), b);
        b.onclick = () => {
            state.tracked = kind === 'add' ? [...state.tracked, name] : state.tracked.filter(p => p !== name);
            saveTracked();
            renderDialog();
            renderProjects();
            renderBoard();
        };
        return r;
    };
    const others = Object.keys(c).filter(p => !state.tracked.includes(p)).sort((a, b) => c[b] - c[a]);
    const add = waButton('New project…', 'd-new-btn', { variant: 'brand', appearance: 'outlined' });
    add.onclick = () => {
        $('dlg').open = false;
        openNewProject();
    };
    const existing = waButton('Open existing folder…', 'd-open-btn', { variant: 'brand', appearance: 'outlined' });
    existing.onclick = () => {
        $('dlg').open = false;
        openNewProject('open');
    };
    const pairBtn = waButton('Pair a device…', 'd-pair-btn', { variant: 'brand', appearance: 'outlined' });
    pairBtn.onclick = () => {
        $('dlg').open = false;
        openPairing();
    };
    const logBtn = waButton('Activity log…', 'd-log-btn', { variant: 'brand', appearance: 'outlined' });
    logBtn.title = 'What happened in the selected project in the last 7 days (l)';
    logBtn.onclick = () => {
        $('dlg').open = false;
        openLog();
    };
    const top = el('div', 'd-new');
    // a paired device (data-remote from the server) cannot pair others: the server answers 403 there
    top.append(add, existing, ...('remote' in document.documentElement.dataset ? [] : [pairBtn]), logBtn);
    body.replaceChildren(
        top,
        el('h4', null, 'On board'),
        ...(state.tracked.length ? [...state.tracked].sort().map(p => row(p, 'rm')) : [el('div', 'd-empty', 'None yet.')]),
        el('h4', null, 'Seen in recent sessions'),
        ...(others.length ? others.map(p => row(p, 'add')) : [el('div', 'd-empty', 'Nothing else found.')])
    );
}
// "Pair a device…": a fresh one-time code for a phone on the tailnet, and the paired devices with Revoke.
async function renderDevices() {
    const r = await api('/api/pair/devices');
    if (!r.ok) {
        $('pair-err').textContent = await r.text();
        return;
    }
    /** @type {{ id: string, name: string, created: number, lastSeen: number }[]} */
    const list = await r.json();
    $('pair-list').replaceChildren(...(list.length ? list.map(d => {
        const row = el('div', 'p-row'), b = waButton('Revoke', 'rm');
        row.append(el('span', null, d.name), el('small', null, ago(d.lastSeen) === 'now' ? 'seen now' : `seen ${ago(d.lastSeen)} ago`), b);
        b.onclick = async () => {
            const res = await api(`/api/pair/revoke?id=${encodeURIComponent(d.id)}`, { method: 'POST' });
            $('pair-err').textContent = res.ok ? '' : await res.text();
            renderDevices();
        };
        return row;
    }) : [el('div', 'd-empty', 'None yet.')]));
}
async function newPairCode() {
    const r = await api('/api/pair/code', { method: 'POST' });
    $('pair-err').textContent = r.ok ? '' : await r.text();
    $('pair-code').textContent = r.ok ? (await r.json()).code : '';
}
function openPairing() {
    $('pair-dlg').open = true;
    newPairCode();
    renderDevices();
}
$('pair-new').onclick = () => {
    newPairCode();
    renderDevices();
};
$('manage').onclick = () => {
    renderDialog();
    $('dlg').open = true;
};

// A project made or opened from "New project…": tracked, selected, and its chat bound as soon as its session is known.
initNewProject(({ name, dir, sessionId, tmux }) => {
    if (!state.tracked.includes(name)) {
        state.tracked = [...state.tracked, name];
        saveTracked();
    }
    state.project = name;
    store.set('project', name);
    renderProjects();
    renderBoard();
    if (sessionId) {
        bindChat(sessionId);
    } else {
        state.startingTmux = tmux;
        state.starting = dir; // poll() binds the chat once a session in that folder shows up
        refreshChat();
    }
    refreshLog();
});

// Projects are named after their git repo now; map saved names that were folder names (e.g. codetool → homebase).
function migrateTracked() {
    const folder = /** @param {Session} s */ s => (s.cwd || '').replace(/\/\.(claude\/)?worktrees\/.*$/, '').split('/').pop();
    const rename = n => state.sessions.some(s => s.project === n) ? n : (state.sessions.find(s => folder(s) === n)?.project ?? n);
    const tracked = [...new Set(state.tracked.map(rename))];
    if (tracked.join() !== state.tracked.join()) {
        state.tracked = tracked;
        saveTracked();
    }
    const project = state.project === 'all' ? 'all' : rename(state.project);
    if (project !== state.project) {
        state.project = project;
        store.set('project', project);
    }
}

// /?chat=<id>, a push notification's link: once that session is in the list, show its project and bind its chat.
let linkedChat = new URLSearchParams(location.search).get('chat');
if (linkedChat) {
    history.replaceState(null, '', '/');
}
function openLinkedChat() {
    const s = linkedChat && state.sessions.find(x => x.id === linkedChat);
    if (!s) {
        return;
    }
    linkedChat = null;
    state.project = state.tracked.includes(s.project) ? s.project : 'all';
    store.set('project', state.project);
    bindChat(s.id);
}

// Push notifications on this device (the ⋯ menu): sw.js shows them even with the page closed. iOS only allows it for a
// Home Screen web app. pushNow is the state shown, kept in sync so a click asks for permission before any await (iOS needs that).
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || /** @type {any} */ (navigator).standalone === true;
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
/** @type {'on' | 'off' | 'home' | 'unsupported' | 'blocked'} */
let pushNow = 'off';
async function renderPush(error = '') {
    const reg = pushSupported && await navigator.serviceWorker.getRegistration().catch(() => null);
    pushNow = ios && !standalone ? 'home' : !pushSupported ? 'unsupported' : Notification.permission === 'denied' ? 'blocked'
        : (await reg?.pushManager.getSubscription().catch(() => null)) ? 'on' : 'off';
    $('push-label').textContent = `${pushNow === 'on' ? 'Turn off' : 'Enable'} notifications on this device`;
    $('push-state').textContent = error || {
        on: 'On', off: 'Off', home: 'Add Homebase to your Home Screen first', unsupported: 'Not supported in this browser', blocked: 'Blocked in browser settings'
    }[pushNow];
}
/** @param {string} b64 */
const keyBytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function togglePush() {
    if (pushNow !== 'on' && pushNow !== 'off') {
        return renderPush();
    }
    try {
        if (pushNow === 'off' && await Notification.requestPermission() !== 'granted') {
            return renderPush();
        }
        const reg = await navigator.serviceWorker.register('/sw.js');
        const old = await reg.pushManager.getSubscription();
        if (old) {
            await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: old.endpoint }) });
            await old.unsubscribe();
        } else {
            const { key } = await api('/api/push/key').then(r => r.json());
            const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
            const r = await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub) });
            if (!r.ok) {
                await sub.unsubscribe();
                throw new Error(await r.text());
            }
        }
        await renderPush();
    } catch (e) {
        await renderPush(`Failed: ${e.message}`);
    }
}
$('plus-menu').addEventListener('wa-select', e => {
    if (e.detail.item.value === 'push') {
        togglePush();
    }
});
if (pushSupported) {
    navigator.serviceWorker.register('/sw.js').catch(() => {}).finally(renderPush);
} else {
    renderPush();
}

const notifyOn = () => store.get('notify') === '1' && window.Notification?.permission === 'granted';
/** @param {AttentionEvent} e @returns {[string, string | undefined]} */
function eventText({ kind, item: x, session: s, comments }) {
    if (kind === 'asking') {
        const what = `${s.project} · ${s.title || sessionTopic(s)}`;
        return s.asking ? [`${what} is asking`, s.question ?? undefined] : [`${what} needs you`, 'Claude’s last reply wants your decision'];
    }
    const ref = x.pr ? prLabel(x.pr) : x.title;
    /** @type {Record<Exclude<AttentionEvent['kind'], 'asking'>, [string, string | undefined]>} */
    const texts = {
        'needs-you': [`Needs you: ${x.title} — ${x.next}`, undefined],
        ready: [`Ready to merge: ${ref}`, x.title],
        finished: [`Agent finished: ${x.title}`, x.column === 'doing' ? undefined : x.next],
        failing: [`Pipeline failing: ${ref}`, x.title],
        comment: [`💬 ${authorSummary(comments ?? [])} commented on ${ref}`, comments?.[0]?.excerpt]
    };
    return texts[kind];
}
/** @param {AttentionEvent} e */
function notify(e) {
    if (!notifyOn() || (document.visibilityState === 'visible' && document.hasFocus())) {
        return;
    }
    const { kind, item: x, session: s } = e, [title, body] = eventText(e);
    const tag = kind === 'asking' ? `asking:${s.id}` : kind === 'comment' ? `${x.key}:comment` : x.key;

    const n = new Notification(title, { body, tag, icon: '/icon.svg' });
    n.onclick = () => {
        window.focus();
        n.close();
        if (s) {
            return focusChat(s.id);
        }
        const it = state.sessions.flatMap(s => s.items || []).find(i => i.key === x.key);
        if (it && state.selected !== it.key) {
            select(it);
        }
        document.querySelector('.rows tr.sel')?.scrollIntoView({ block: 'center' });
    };
}
const bell = $('bell');
// the off icon is a bell with a slash; on adds an accent dot (styled in styles.css)
const renderBell = () => {
    const on = notifyOn();
    bell.classList.toggle('on', on);
    bell.setAttribute('aria-pressed', on);
};
bell.hidden = !window.Notification;
// permission is only ever requested from this click
let blocked = null;
bell.onclick = async () => {
    const on = !notifyOn() && await Notification.requestPermission() === 'granted';
    if (!on && Notification.permission === 'denied') { // the browser asks nothing then: say why nothing happened
        blocked ??= tooltip(bell, 'Blocked in browser settings');
        bell.after(blocked);
        blocked.open = true;
    }
    store.set('notify', on ? '1' : '0');
    renderBell();
};
if (window.Notification) {
    renderBell();
}

// Refresh button (and r): the server refetches every GitLab/GitHub cache, keeping the old data meanwhile; the icon spins
// until that is done, then the list and the milestone pill poll at once. Ignored while running and within 5 s of the last start.
const reload = $('reload');
let refreshedAt = 0, refreshStarted = 0;
const renderReload = () => {
    const s = (Date.now() - refreshedAt) / 1000 | 0, when = s < 60 ? `${s}s` : ago(refreshedAt);
    $('reload-tip').replaceChildren('Refresh from GitLab/GitHub (r)', ...(refreshedAt ? [el('br'), `Last refreshed ${when} ago`] : []));
};
hooks.refresh = async () => {
    if (reload.classList.contains('spin') || Date.now() - refreshStarted < 5000) {
        return;
    }
    refreshStarted = Date.now();
    reload.classList.add('spin');
    reload.setAttribute('aria-busy', 'true');
    try {
        refreshedAt = /** @type {RefreshState} */ (await api('/api/refresh', { method: 'POST' }).then(r => r.json())).lastRefreshedAt;
    } catch {}
    reload.classList.remove('spin');
    reload.removeAttribute('aria-busy');
    document.dispatchEvent(new Event('homebase:refresh')); // the milestone pill refetches
    poll();
};
reload.onclick = () => hooks.refresh();
api('/api/refresh').then(r => r.json()).then(/** @param {RefreshState} d */ d => {
    refreshedAt = d.lastRefreshedAt;
    renderReload();
}).catch(() => {});

// Header note when Homebase changed on disk: server code (Reload server: the server replaces itself, and the page reloads
// once a new server pid answers) or only browser files (Refresh). page.updated is a restart that brought new code.
/** @type {{ pid: number, serverStale: boolean, page: string } | undefined} */
let firstVersion;
let reloadingSince = 0;
async function refreshVersion() {
    /** @type {typeof firstVersion} */
    let v;
    try {
        const r = await api('/api/version');
        v = r.ok ? await r.json() : undefined;
    } catch {}
    if (!v) {
        return; // offline: the Offline note says so
    }
    firstVersion ??= v;
    if (reloadingSince && v.pid !== firstVersion.pid) {
        location.reload(); // fresh client files from the new server
        return;
    }
    if (Date.now() - reloadingSince > 20_000) {
        reloadingSince = 0; // the new server never came (see server.log in the Homebase dir): offer it again
    }
    const server = v.serverStale, fresh = page.updated || v.page !== firstVersion.page, go = $('updated-go');
    $('updated').hidden = !server && !fresh && !reloadingSince;
    $('updated-text').textContent = reloadingSince ? 'Reloading the server…' : server ? 'Homebase was updated —' : 'Page updated —';
    go.hidden = Boolean(reloadingSince);
    go.textContent = server ? 'Reload server' : 'Refresh';
    go.onclick = !server ? () => location.reload() : async () => {
        reloadingSince = Date.now();
        refreshVersion();
        await api('/api/server/reload', { method: 'POST' }).catch(() => {});
    };
}

let lastSessions = '', lastRender = 0, polling = false;
/** @type {Session[] | undefined} */
let prevSessions; // the previous poll's, for askingEvents
async function poll() {
    // a slow /api/sessions must not stack polls whose answers land out of order
    if (polling) {
        return;
    }
    polling = true;
    try {
        await pollOnce();
    } finally {
        polling = false;
    }
}
// After a page reload: a project whose chat is still starting (tmux running, no transcript) is found again by name.
async function findStarting() {
    if (state.startingTmux || state.project === 'all' || chatSession()) {
        return;
    }
    try {
        const r = await api('/api/starting');
        const hit = r.ok && (await r.json()).find(x => x.name === state.project);
        if (hit) {
            state.startingTmux = hit.tmux;
            state.starting = hit.dir;
        }
    } catch {}
}
// Review requests change slowly (the server caches them for 2 min): ask every 5 s (a local cache hit; GitLab is asked at most every 2 min); a failure hides the rows.
let reviewsAt = 0;
async function pollReviews() {
    if (Date.now() - reviewsAt < 5_000) {
        return;
    }
    reviewsAt = Date.now();
    try {
        const r = await api('/api/reviews');
        if (!r.ok) {
            return; // keep showing the last list
        }
        const list = await r.json();
        if (JSON.stringify(list) !== JSON.stringify(state.reviews ?? [])) {
            state.reviews = list;
            renderBoard();
        }
    } catch {} // keep showing the last list
}

async function pollOnce() {
    pollReviews();
    try {
        const r = await api(`/api/sessions${document.hasFocus() ? '?focused=1' : ''}`); // a focused page holds back phone pushes
        if (!r.ok) {
            throw new Error(String(r.status));
        }
        const text = await r.text();
        // ponytail: skip identical re-renders so text in an open detail stays selectable; re-render each minute for the ages
        if (text !== lastSessions || Date.now() - lastRender > 60_000) {
            state.sessions = /** @type {Session[]} */ (JSON.parse(text));
            migrateTracked();
            openLinkedChat();
            lastSessions = text;
            lastRender = Date.now();
            try {
                sessionStorage.setItem('sessions', text);
            } catch {}
            // by its tmux too: an opened folder's older sessions are not this chat
            const started = state.starting && state.sessions.find(s => s.cwd === state.starting && s.tmux === state.startingTmux && isMaster(s));
            if (started) {
                state.starting = null;
                state.startingTmux = null;
                bindChat(started.id);
            }
            renderProjects();
            renderBoard();
            if (activeTab() === 'issues') {
                renderIssues(); // the cards' Start button and "starting…" follow the chat session
            }
            // diffed over all items, then filtered to every tracked project (not only the selected one), so changing the project filter doesn't read as transitions
            const items = state.sessions.flatMap(s => s.items || []);
            const events = [...askingEvents(prevSessions, state.sessions), ...attentionEvents(state.items, items, x => seenAt(x.pr))].filter(e => isTracked(e.item ?? e.session));
            events.forEach(notify);
            // screen readers hear the same transitions, notifications on or not
            if (events.length) {
                $('announce').textContent = events.map(e => eventText(e)[0]).join('. ');
            }
            state.items = items;
            prevSessions = state.sessions;
        }
        setOffline(false);
        setFormatWarn('transcript', state.sessions.some(s => s.known === false));
        updateTitle();
    } catch {
        setOffline(true);
    }
    await findStarting();
    refreshChat();
    refreshLimits();
    renderReload();
    refreshLog();
    refreshVersion();
}

// "Session ▬ 70%   Week ▬ 63%"; reset times live in each item's tooltip. Hidden without a dump.
const leftColor = left => (left >= 50 ? 'var(--c-ready)' : left >= 10 ? 'var(--c-warn)' : 'var(--c-danger)');
/** @type {[number, number][]} */
let paceSamples = [];
let paceReset = 0;
async function refreshLimits() {
    /** @type {Limits | null} */
    let l = null;
    try {
        l = await api('/api/limits').then(r => r.json());
    } catch {}
    state.limits = l;
    const box = $('limits'), wins = [l?.fiveHour, l?.sevenDay].map((w, week) => w && limitView(week, w)).filter(Boolean);
    const a = l?.updated && ago(l.updated), updated = !a ? '' : a === 'now' ? 'Updated just now' : `Updated ${a} ago`;
    box.hidden = !wins.length;
    // rebuild only when the set of windows changes, then update in place so an open tooltip survives the 3s refresh
    const key = wins.map(v => v.label).join();
    if (box.dataset.key !== key) {
        box.dataset.key = key;
        box.replaceChildren(...wins.flatMap(() => {
            const s = el('span', 'limit'), bar = el('i');
            bar.append(el('b'));
            s.append(el('span', 'limit-label'), bar, el('span'));
            return [s, tooltip(s, '')];
        }));
    }
    // pace of the 5-hour window: a sample a minute (reset by a new window), the last 8
    const f = l?.fiveHour, now = Date.now();
    if (f?.resetsAt !== paceReset) {
        paceSamples = [];
        paceReset = f?.resetsAt ?? 0;
    }
    if (f && (!paceSamples.length || now - paceSamples.at(-1)[0] >= 60_000)) {
        paceSamples = [...paceSamples, /** @type {[number, number]} */ ([now, f.used])].slice(-8);
    }
    const out = f && runOutIn(paceSamples, f.resetsAt, now);
    box.querySelector('.limit-pace')?.remove();
    if (out) {
        const p = el('span', 'limit-pace', `· empty in ~${out}m`);
        p.style.color = 'var(--c-warn)';
        box.append(p);
    }
    box.querySelectorAll('.limit').forEach((s, i) => {
        const v = wins[i], [name, bar, val] = s.children, fill = /** @type {HTMLElement} */ (bar.firstChild);
        name.textContent = v.label;
        val.textContent = v.text;
        fill.style.width = `${v.left}%`;
        fill.style.background = leftColor(v.left);
        s.nextElementSibling.replaceChildren(v.tip, ...(updated ? [el('br'), updated] : []));
    });
}

for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#tabs button'))) {
    b.onclick = () => showTab(b.dataset.tab);
}
// with two segments every arrow key goes to the other one; selection follows focus, as in a tablist
$('tabs').addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        const want = e.key === 'Home' ? 'work' : e.key === 'End' ? 'issues' : activeTab() === 'work' ? 'issues' : 'work';
        showTab(want);
        /** @type {HTMLElement} */ (document.querySelector(`#tabs [data-tab="${want}"]`)).focus();
        e.preventDefault();
    }
});
showTab(store.get('tab'));

// Narrow windows (≤ 900px, styles.css: phones, and desktops zoomed in): the bottom bar shows the chat or one board tab. body[data-pane] does nothing wider.
/** @param {string} pane chat, work or issues */
function showPane(pane) {
    document.body.dataset.pane = pane === 'chat' ? 'chat' : 'board';
    if (pane !== 'chat') {
        showTab(pane);
    }
    for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#ptabs button'))) {
        b.setAttribute('aria-pressed', String(b.dataset.pane === pane));
    }
}
for (const b of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('#ptabs button'))) {
    b.onclick = () => showPane(b.dataset.pane);
}
showPane('chat');
// The on-screen keyboard on a phone. Android shrinks the page itself (interactive-widget in index.html). iOS only shrinks
// the visual viewport and scrolls the page up to the input, which takes the header off screen: there the body gets the
// visible height (--vvh, styles.css) and the page stays unscrolled. No keyboard, pinch-zoomed or wider: back to 100dvh.
const vv = window.visualViewport, phoneWidth = matchMedia('(max-width: 900px)');
function fitKeyboard() {
    const root = document.documentElement;
    if (!phoneWidth.matches || vv.scale !== 1 || vv.height >= innerHeight - 1) {
        root.style.removeProperty('--vvh');
        return;
    }
    root.style.setProperty('--vvh', `${vv.height}px`);
    scrollTo(0, 0);
}
vv?.addEventListener('resize', fitKeyboard);
vv?.addEventListener('scroll', fitKeyboard);
// A tap on the board that picks a chat, or on an "is asking" row, opens the chat pane; capture runs before the row's handler.
let chatBefore = null;
const board = document.querySelector('.left');
board.addEventListener('click', () => { chatBefore = state.chat; }, true);
board.addEventListener('click', e => {
    if (document.body.dataset.pane === 'board' && (state.chat !== chatBefore || /** @type {Element} */ (e.target).closest?.('tr.asking'))) {
        showPane('chat');
    }
});
initKeys(); // includes Esc collapsing the expanded row
initChat();
// The last good list survives a manual reload, so a failing server shows dimmed data rather than an empty board.
try {
    state.sessions = JSON.parse(sessionStorage.getItem('sessions')) || [];
    migrateTracked();
    renderProjects();
    renderBoard();
} catch {}
// The server's list wins (the Mac's and every paired phone's board are one); none saved yet, this browser's list becomes it.
api('/api/tracked').then(r => (r.ok ? r.json() : undefined)).then(list => {
    if (list === null && state.tracked.length) {
        saveTracked();
    } else if (Array.isArray(list) && list.join() !== state.tracked.join()) {
        state.tracked = list;
        store.set('tracked', JSON.stringify(list));
        renderProjects();
        renderBoard();
    }
}).catch(() => {});
poll();
setInterval(poll, 1500); // /api/sessions costs ~40ms warm (GitLab stays behind its own caches), so a new row or Now: line lands within ~1.5s
