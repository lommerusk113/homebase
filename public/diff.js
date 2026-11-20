// The Changes view: what a chat or a helper changed in its git folder (GET /api/diff, server/diff.mjs), read-only.
// A full-screen panel: the changed files left ("Uncommitted", "Committed on this branch"), the picked file's unified
// diff right; on a phone the list first, then the diff with a back button. Diff text only ever reaches textContent.
import { api, el, waButton, state, PR_HREF } from './core.js';

const LINES = 500; // drawn at a time; "Show more" adds the next ones
const COUNT_MS = 15_000; // the chat header's count is re-read at most this often, and only when the chat moved
const GROUPS = /** @type {const} */ ([['uncommitted', 'Uncommitted'], ['committed', 'Committed on this branch']]);

// A unified diff as rows: h (hunk header), + (added), - (removed), ' ' (context) and m (a note such as "No newline at
// end of file"), with the old and new line numbers. The file header above the first hunk is dropped.
/** @param {string} text @returns {DiffRow[]} */
export function parseDiff(text) {
    /** @type {DiffRow[]} */
    const rows = [];
    let o = 0, n = 0, inHunk = false;
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    for (const line of lines) {
        const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) {
            o = Number(h[1]);
            n = Number(h[2]);
            inHunk = true;
            rows.push({ t: 'h', text: line });
        } else if (!inHunk) {
            continue;
        } else if (line[0] === '+') {
            rows.push({ t: '+', n: n++, text: line.slice(1) });
        } else if (line[0] === '-') {
            rows.push({ t: '-', o: o++, text: line.slice(1) });
        } else if (line[0] === '\\') {
            rows.push({ t: 'm', text: line.slice(2) });
        } else {
            rows.push({ t: ' ', o: o++, n: n++, text: line.slice(1) });
        }
    }
    return rows;
}

// An untracked file: every line is new.
/** @param {string} text @returns {DiffRow[]} */
export function addedRows(text) {
    const lines = text.split('\n');
    if (lines.at(-1) === '') {
        lines.pop();
    }
    return lines.map((line, i) => ({ t: '+', n: i + 1, text: line }));
}

// Files (a path counted once) and added/removed lines over both groups.
/** @param {DiffView} v */
export function diffTotals(v) {
    const all = [...v.uncommitted ?? [], ...v.committed ?? []];
    return { files: new Set(all.map(f => f.path)).size, add: all.reduce((n, f) => n + (f.add ?? 0), 0), del: all.reduce((n, f) => n + (f.del ?? 0), 0) };
}

const phone = () => matchMedia('(max-width: 700px)').matches;
/** @param {string} sid @param {string | null} item @param {Record<string, string>} [more] */
const urlOf = (sid, item, more = {}) => `/api/diff?${new URLSearchParams({ session: sid, ...(item != null && { item }), ...more })}`;
/** @param {string} url */
async function getJson(url) {
    const r = await api(url);
    if (!r.ok) {
        throw new Error(await r.text());
    }
    return r.json();
}

/** @type {{ sid: string, item: string | null, view: DiffView | null, sel: string | null, bodies: Map<string, DiffBody>, back: Element | null } | null} */
let open = null;
/** @type {HTMLElement | null} */
let panel = null;
const part = cls => /** @type {HTMLElement} */ (panel.querySelector(`.${cls}`));
/** @param {string} group @param {string} path */
const keyOf = (group, path) => `${group}\0${path}`;
const fileButtons = () => [.../** @type {NodeListOf<HTMLButtonElement>} */ (panel.querySelectorAll('.dv-file'))];

function build() {
    panel = el('div', 'dv');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-label', 'Changes');
    panel.tabIndex = -1;
    const head = el('header', 'dv-head'), back = el('button', 'dv-btn dv-back', '← Files'), title = el('div', 'dv-title'), totals = el('span', 'dv-totals');
    const mr = el('a', 'dv-btn dv-mr', 'Open MR'), refresh = el('button', 'dv-btn dv-refresh', 'Refresh'), close = el('button', 'dv-btn dv-close', '×');
    mr.target = '_blank';
    mr.rel = 'noopener';
    refresh.title = 'Refresh (r)';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close');
    for (const b of [back, refresh, close]) {
        b.type = 'button';
    }
    back.onclick = () => panel.classList.remove('one');
    refresh.onclick = load;
    close.onclick = closeDiff;
    head.append(back, title, totals, mr, refresh, close);
    const body = el('div', 'dv-body'), files = el('nav', 'dv-files'), pane = el('section', 'dv-pane');
    files.setAttribute('aria-label', 'Changed files');
    const phead = el('div', 'dv-phead'), path = el('span', 'dv-path mono'), copy = el('button', 'dv-btn dv-copy', 'Copy path');
    copy.type = 'button';
    copy.onclick = () => navigator.clipboard.writeText(path.textContent).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => { copy.textContent = 'Copy path'; }, 1500);
    });
    phead.append(path, copy);
    pane.append(phead, el('div', 'dv-code'));
    body.append(files, pane);
    panel.append(head, body);
    // while the panel is up every key is its own: the board's shortcuts (keys.js) never see them
    window.addEventListener('keydown', onKey, true);
}

/** @param {KeyboardEvent} e */
function onKey(e) {
    if (!open) {
        return;
    }
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
    }
    const step = { j: 1, ArrowDown: 1, k: -1, ArrowUp: -1 }[e.key];
    if (e.key === 'Escape') {
        closeDiff();
    } else if (e.key === 'r') {
        load();
    } else if (step) {
        const all = fileButtons(), i = all.findIndex(b => b.dataset.key === open.sel);
        const next = all[i < 0 ? (step > 0 ? 0 : all.length - 1) : Math.max(0, Math.min(all.length - 1, i + step))];
        if (next) {
            pick(next.dataset.group, next.dataset.path);
        }
    } else {
        return;
    }
    e.preventDefault();
}

// The MR of what is shown: the row's own, else the MR of this chat's item on the same branch.
function mrUrl() {
    const items = state.sessions.flatMap(s => s.items ?? []);
    return open.item != null
        ? items.find(i => i.key === open.item)?.pr ?? null
        : items.find(i => i.pr && i.sessionId === open.sid && i.branch && i.branch === open.view?.branch)?.pr ?? null;
}

/** @param {HTMLElement} box @param {string} text */
const note = (box, text) => box.replaceChildren(el('div', 'dv-note', text));
/** @param {DiffFile} f */
function counts(f) {
    const c = el('span', 'dv-counts');
    if (f.binary) {
        c.textContent = 'binary';
    } else if (f.add != null) {
        c.append(el('span', 'dv-add', `+${f.add}`), ' ', el('span', 'dv-del', `−${f.del}`));
    } else if (f.status === '?') {
        c.textContent = 'new';
    }
    return c;
}

function drawList() {
    const v = open.view, files = part('dv-files'), t = diffTotals(v);
    part('dv-title').replaceChildren(el('b', null, v.repo), ' ', el('span', 'dv-branch mono', v.branch || '(no branch)'),
        ...(v.base ? [' → ', el('span', 'dv-branch mono', v.base.ref)] : []));
    part('dv-title').title = v.base ? `${v.branch} compared with ${v.base.ref} at ${v.base.sha.slice(0, 8)}` : '';
    part('dv-totals').replaceChildren(`${t.files} file${t.files === 1 ? '' : 's'} `, el('span', 'dv-add', `+${t.add}`), ' ', el('span', 'dv-del', `−${t.del}`));
    const mr = /** @type {HTMLAnchorElement} */ (part('dv-mr')), url = mrUrl(), ok = PR_HREF.test(url ?? ''); // only an https MR/PR link
    mr.hidden = !ok;
    mr.toggleAttribute('href', false);
    if (ok) {
        mr.href = url;
    }
    files.replaceChildren();
    for (const [group, label] of GROUPS) {
        const list = v[group];
        if (!list.length) {
            continue;
        }
        files.append(el('h4', 'dv-group', `${label} · ${list.length}`));
        for (const f of list) {
            const b = el('button', 'dv-file'), slash = f.path.lastIndexOf('/') + 1, name = el('span', 'dv-name');
            b.type = 'button';
            b.dataset.group = group;
            b.dataset.path = f.path;
            b.dataset.key = keyOf(group, f.path);
            b.title = f.path;
            name.append(el('span', 'dv-dir', f.path.slice(0, slash)), el('span', 'dv-base', f.path.slice(slash)));
            b.append(el('span', `dv-st st-${/[A-Z]/.test(f.status) ? f.status : 'new'}`, f.status), name, counts(f));
            b.onclick = () => pick(group, f.path);
            files.append(b);
        }
    }
    if (v.truncated) {
        files.append(el('div', 'dv-note', 'Too many files: the list is cut short.'));
    }
}

/** @param {HTMLElement} box @param {DiffRow[]} rows @param {number} from */
function drawRows(box, rows, from) {
    box.querySelector('.dv-more')?.remove();
    const lines = /** @type {HTMLElement} */ (box.querySelector('.dv-lines')) ?? box.appendChild(el('div', 'dv-lines mono'));
    const cls = { h: 'hunk', '+': 'add', '-': 'del', m: 'meta', ' ': '' };
    lines.append(...rows.slice(from, from + LINES).map(r => {
        const line = el('div', `dv-l ${cls[r.t]}`);
        line.append(el('span', 'dv-n', r.o ?? ''), el('span', 'dv-n', r.n ?? ''), el('span', 'dv-t', (r.t === 'h' || r.t === 'm' ? '' : r.t) + r.text));
        return line;
    }));
    const left = rows.length - from - LINES;
    if (left > 0) {
        const more = el('button', 'dv-btn dv-more', `Show more (${left} lines left)`);
        more.type = 'button';
        more.onclick = () => drawRows(box, rows, from + LINES);
        box.append(more);
    }
}

/** @param {string} group @param {string} path */
async function pick(group, path) {
    const key = keyOf(group, path), box = part('dv-code'), was = open;
    open.sel = key;
    for (const b of fileButtons()) {
        const on = b.dataset.key === key;
        b.setAttribute('aria-current', String(on));
        if (on) {
            b.scrollIntoView({ block: 'nearest' });
        }
    }
    part('dv-path').textContent = path;
    part('dv-phead').hidden = false;
    panel.classList.add('one');
    if (!open.bodies.has(key)) {
        note(box, 'Loading…');
        try {
            open.bodies.set(key, await getJson(urlOf(open.sid, open.item, { group, file: path })));
        } catch (e) {
            if (open === was && open.sel === key) {
                note(box, e.message === 'unknown file' ? 'This file is no longer in the list. Refresh to see the current changes.' : `Couldn't load the diff: ${e.message}`);
            }
            return;
        }
    }
    if (open !== was || open.sel !== key) { // closed, or another file picked meanwhile
        return;
    }
    const body = open.bodies.get(key);
    const rows = body.diff != null ? parseDiff(body.diff) : body.text != null ? addedRows(body.text) : [];
    box.scrollTo(0, 0);
    if (body.binary) {
        note(box, 'Binary file: no text diff.');
    } else if (body.tooLarge) {
        note(box, 'Diff too large to show here.');
    } else if (!rows.length) {
        note(box, 'No text changes (empty file, or only its mode changed).');
    } else {
        box.replaceChildren();
        drawRows(box, rows, 0);
    }
}

async function load() {
    const was = open, box = part('dv-code');
    panel.classList.add('loading');
    try {
        const view = await getJson(urlOf(open.sid, open.item));
        if (open !== was) {
            return;
        }
        open.view = view;
        open.bodies.clear();
        if (was.item == null && was.sid === head.sid) {
            paintCount(view);
        }
    } catch (e) {
        if (open === was) {
            part('dv-files').replaceChildren();
            part('dv-phead').hidden = true;
            panel.classList.add('empty');
            note(box, `Couldn't read the changes: ${e.message}`);
        }
        return;
    } finally {
        panel.classList.remove('loading');
    }
    const v = open.view, all = v.repo ? [...v.uncommitted.map(f => keyOf('uncommitted', f.path)), ...v.committed.map(f => keyOf('committed', f.path))] : [];
    panel.classList.toggle('empty', !all.length);
    if (!all.length) {
        panel.classList.remove('one');
        part('dv-files').replaceChildren();
        part('dv-phead').hidden = true;
        part('dv-totals').replaceChildren();
        part('dv-mr').hidden = true;
        if (!v.repo) {
            part('dv-title').replaceChildren(el('b', null, 'Changes'));
            return note(box, 'No git repository here: the folder is gone or is not inside one.');
        }
        drawList();
        return note(box, v.base ? `No changes: nothing uncommitted, and nothing committed on ${v.branch} since ${v.base.ref}.` : 'No changes: nothing uncommitted.');
    }
    drawList();
    // keep the picked file over a refresh; a desktop starts on the first one, a phone on the list
    const keep = all.includes(open.sel) ? open.sel : phone() ? null : all[0];
    if (!keep) {
        open.sel = null;
        panel.classList.remove('one');
        return note(box, 'Pick a file to see its diff.');
    }
    const b = fileButtons().find(x => x.dataset.key === keep);
    return pick(b.dataset.group, b.dataset.path);
}

// Opens the panel for a session's folder, or with item (a work item's key) for that item's worktree.
/** @param {string} sid @param {string | null} [item] */
export function openDiff(sid, item = null) {
    if (!panel) {
        build();
    }
    open = { sid, item, view: null, sel: null, bodies: new Map(), back: document.activeElement };
    panel.classList.remove('one', 'empty');
    part('dv-title').replaceChildren(el('b', null, 'Changes'));
    part('dv-totals').replaceChildren();
    part('dv-files').replaceChildren();
    part('dv-mr').hidden = true;
    part('dv-phead').hidden = true;
    note(part('dv-code'), 'Loading…');
    document.body.append(panel);
    panel.focus();
    load();
}

export function closeDiff() {
    if (!open) {
        return;
    }
    const back = open.back;
    open = null;
    panel.remove();
    if (back instanceof HTMLElement && back.isConnected) {
        back.focus({ preventScroll: true });
    }
}

// A work row's "Changes" icon, only when its helper's worktree has changes (an MR row without a worktree gets none:
// the chat's folder would show unrelated changes). Each row's count is read when the row is drawn and at most every
// COUNT_MS after, never on the poll itself; a count that changes redraws the board.
const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 6.5v7M8.5 10h7M8.5 17h7"/></svg>';
/** @type {Map<string, { at: number, n: number }>} item key -> changed files */
const rowCounts = new Map();
/** @param {WorkItem} x @param {() => void} redraw @returns {HTMLElement[]} */
export function diffIcon(x, redraw) {
    if (!x.worktreePath || !x.sessionId) {
        return [];
    }
    const hit = rowCounts.get(x.key), was = hit?.n ?? 0;
    if (!document.hidden && (!hit || Date.now() - hit.at >= COUNT_MS)) {
        rowCounts.set(x.key, { at: Date.now(), n: was }); // one fetch at a time per row
        getJson(urlOf(x.sessionId, x.key)).then(v => {
            const n = v.repo ? diffTotals(v).files : 0;
            rowCounts.set(x.key, { at: Date.now(), n });
            if (n !== was) {
                redraw();
            }
        }, () => {});
    }
    if (!was) {
        return [];
    }
    const b = waButton('', 'act-btn dv-row', { appearance: 'plain', 'aria-label': 'Changes', title: 'Changes' });
    b.innerHTML = ICON;
    b.onclick = e => {
        e.stopPropagation();
        openDiff(x.sessionId, x.key);
    };
    return [b];
}

// The chat header's "Changes" button with the number of changed files. The number is read when the chat changes and,
// while its transcript moves, at most every COUNT_MS: never on the poll itself.
const head = { sid: /** @type {string | null} */ (null), at: 0, updated: 0 };
/** @param {DiffView | null} v */
function paintCount(v) {
    const n = document.querySelector('.c-diff-n');
    if (n) {
        const files = v?.repo ? diffTotals(v).files : 0;
        n.textContent = String(files);
        /** @type {HTMLElement} */ (n).hidden = !files;
    }
}
/** @param {Session | null} s */
export function syncDiff(s) {
    let b = /** @type {HTMLButtonElement | null} */ (document.getElementById('c-diff'));
    if (!b) {
        b = el('button', 'c-diff');
        b.id = 'c-diff';
        b.type = 'button';
        b.title = 'What this chat changed (d)';
        b.setAttribute('aria-label', 'Changes');
        const n = el('span', 'c-diff-n');
        n.hidden = true;
        b.append(el('span', 'c-diff-icon', '±'), el('span', 'c-diff-word', 'Changes'), n);
        b.onclick = () => head.sid && !open && openDiff(head.sid);
        document.getElementById('c-unpushed').after(b);
    }
    const sid = s && !s.id.startsWith('cc-new-') ? s.id : null;
    b.hidden = !sid;
    if (sid !== head.sid) {
        Object.assign(head, { sid, at: 0, updated: 0 });
        paintCount(null);
    }
    if (!sid || document.hidden || Date.now() - head.at < COUNT_MS || (head.at && s.updated === head.updated)) {
        return;
    }
    Object.assign(head, { at: Date.now(), updated: s.updated });
    getJson(urlOf(sid, null)).then(v => { if (head.sid === sid) { paintCount(v); } }, () => {});
}
