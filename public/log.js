// Log tab: the selected project's last 7 days from /api/log, grouped by day: finished subagents (their commits nested),
// loose commits, chat topics and merged/closed MRs. Read-only; fetched when shown or the project changes, then each minute.
import { api, $, el, state, prChip, foldable, rich } from './core.js';
import { topicHue } from './chat.js';

const TTL_MS = 60_000;
let shownFor = null, fetchedAt = 0, lastText = '';

const time = at => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** @param {LogCommit} c @param {string | null} main */
function commit(c, main) {
    const r = el('div', 'lg-c');
    r.append(el('span', 'mono lg-hash', c.short), el('span', 'lg-subj', c.subject));
    if (c.branch && c.branch !== main) r.append(el('span', 'chip mono', c.branch));
    if (c.unpushed) r.append(el('span', 'lg-unpushed', 'not pushed'));
    r.title = `${c.hash}\n${new Date(c.at).toLocaleString()}`;
    return r;
}

/** @param {LogEntry} e @param {LogResponse} d */
function entry(e, d) {
    const li = el('li', `lg-e lg-${e.kind}`), main = el('div', 'lg-main');
    li.append(el('span', 'lg-time', time(e.at)), main);
    if (e.kind === 'agent') {
        const head = el('div', 'lg-head');
        head.append(el('b', null, e.description), el('span', 'lg-meta', [e.time, e.tokens].filter(Boolean).join(' · ')));
        if (e.pr) head.append(prChip({ pr: e.pr, prState: e.prState }));
        main.append(head, ...foldable(e.tldr, e.body, `log:${e.id}`));
        if (e.commits.length) {
            const box = el('div', 'lg-nested');
            box.append(...e.commits.map(c => commit(c, d.defaultBranch)));
            main.append(box);
        }
        li.dataset.key = `log:${e.id}`;
        // a click anywhere on the entry folds the report, except inside the open report or on a link
        li.onclick = ev => { if (!/** @type {Element} */ (ev.target).closest('.body, a')) /** @type {HTMLElement | null} */ (main.querySelector(':scope > .show'))?.click(); };
    } else if (e.kind === 'commit') {
        main.append(commit(e, d.defaultBranch));
    } else if (e.kind === 'topic') {
        li.style.setProperty('--tc', `var(--t${topicHue(e.topic)})`);
        const head = el('div', 'lg-head');
        head.append(el('span', 'lg-tname', e.topic));
        if (e.tldr) head.append(rich(e.tldr, true));
        main.append(head);
    } else {
        const head = el('div', 'lg-head');
        head.append(prChip({ pr: e.url, prState: /** @type {PrState} */ ({ state: e.state }) }), el('span', null, e.title ?? ''));
        main.append(head);
    }
    return li;
}

/** @param {LogResponse} d */
function render(d) {
    const pane = $('log');
    pane.removeAttribute('aria-busy');
    if (!d.days.length) {
        pane.replaceChildren(el('div', 'welcome', d.error ?? `Nothing happened in ${d.project} in the last 7 days.`));
        return;
    }
    pane.replaceChildren(...d.days.map(day => {
        const sec = el('section', 'group lg-day'), list = el('ul', 'lg-list');
        list.append(...day.entries.map(e => entry(e, d)));
        sec.append(el('h3', 'g-head', `${day.label} · ${day.entries.length}`), list);
        return sec;
    }), ...(d.error ? [el('div', 'is-note', d.error)] : []));
}

// Fetches when the tab is visible and the project changed or the last answer is a minute old; re-renders only on change.
export async function refreshLog() {
    const pane = $('log');
    if (pane.hidden) return;
    const project = state.project;
    if (project === shownFor && Date.now() - fetchedAt < TTL_MS) return;
    if (project !== shownFor) {
        shownFor = project; lastText = '';
        if (project === 'all') {
            pane.replaceChildren(el('div', 'welcome', 'Pick a project in the header to see its log.'));
            return;
        }
        pane.replaceChildren(el('div', 'welcome', 'Loading the log…'));
        pane.setAttribute('aria-busy', 'true');
    }
    fetchedAt = Date.now();
    try {
        const r = await api(`/api/log?project=${encodeURIComponent(project)}`);
        // @ts-expect-error Error() stringifies the status
        if (!r.ok) throw new Error(r.status);
        const text = await r.text();
        if (project !== state.project || text === lastText) return; // a late answer for another project, or nothing new
        lastText = text;
        render(/** @type {LogResponse} */ (JSON.parse(text)));
    } catch {
        if (!lastText && project === state.project) pane.replaceChildren(el('div', 'welcome', 'Could not load the log. It retries in a minute.'));
    }
}
