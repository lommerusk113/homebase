// Milestone strips at the top of the work list: progress, due date and issue groups per project. Read-only: only links out.
const GROUPS = [
  ['closable', 'Merged, issue still open — can be closed'],
  ['doing', 'In progress'],
  ['assigned', 'Not started · assigned'],
  ['unassigned', 'Not started · unassigned'],
  ['done', 'Done']
];
const SHORT = { closable: 'can be closed', doing: 'in progress', assigned: 'assigned', unassigned: 'unassigned' };
const FETCH_MS = 30_000; // the server caches the glab calls; this only bounds how stale the strip gets

const CSS = `
  .ms-strip { flex-shrink:0; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:8px 12px; font-size:12.5px; }
  .ms-strip + .ms-strip { margin-top:8px; }
  .ms-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .ms-proj { font-weight:600; color:var(--muted); font-size:11.5px; text-transform:uppercase; letter-spacing:.06em; }
  .ms-pick { position:relative; }
  .ms-pick > summary { list-style:none; cursor:pointer; font-weight:600; color:var(--strong); }
  .ms-pick > summary::-webkit-details-marker { display:none; }
  .ms-pick > summary::after { content:' ▾'; color:var(--muted); font-weight:400; }
  .ms-menu { position:absolute; z-index:5; top:calc(100% + 4px); left:0; min-width:220px; max-height:50vh; overflow:auto; background:var(--bg); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); padding:4px 0; }
  .ms-menu button { display:block; width:100%; text-align:left; appearance:none; border:0; background:none; font:inherit; color:var(--fg); padding:4px 12px; cursor:pointer; white-space:nowrap; }
  .ms-menu button:hover { background:var(--hover); }
  .ms-menu button.on { font-weight:600; }
  .ms-menu small { color:var(--muted); margin-left:6px; }
  .ms-bar { width:120px; height:6px; border-radius:3px; background:var(--line-soft); overflow:hidden; }
  .ms-bar b { display:block; height:100%; background:var(--c-ready); }
  .ms-count { color:var(--muted); }
  .ms-count.hot { color:var(--c-needs); font-weight:600; }
  .ms-more { margin-left:auto; }
  .ms-body h5 { margin:10px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; }
  .ms-chips { display:flex; flex-wrap:wrap; gap:4px; }
  .ms-chips a.chip { max-width:340px; }
  .ms-chips a.chip.hot { background:color-mix(in srgb, var(--c-needs) 16%, var(--bg)); color:var(--c-needs); font-weight:600; }
  .ms-chips a.chip.done { background:var(--chip); color:var(--muted); }
  .ms-chips .who { font-weight:600; }
  .ms-body summary { cursor:pointer; list-style:none; }
  .ms-body summary h5 { display:inline-block; }
  .ms-body summary h5::after { content:' ▸'; }
  .ms-body details[open] summary h5::after { content:' ▾'; }
  .ms-tag { margin-right:6px; font-size:10.5px; font-weight:500; vertical-align:1px; }
`;

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const due = d => (d ? `due ${new Date(d + 'T00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'no due date');
const expanded = new Set(); // projects whose strip is open; survives re-renders, not reloads
const doneOpen = new Set(); // projects whose Done group is unfolded

// Small tag for a work-item row whose MR belongs to a milestone (item.milestone comes from the server).
export function milestoneTag(item) {
  if (!item?.milestone) return null;
  const t = el('span', 'chip ms-tag', `⚑ ${item.milestone}`);
  t.title = `Milestone: ${item.milestone}`;
  return t;
}

// One project's strip from /api/milestones: picker, due date, progress, group counts; expanding shows issue chips per group.
// onPick(title) is called when another milestone is chosen; showProject prefixes the project name (the "All" view).
export function renderMilestone(container, data, { onPick, showProject } = {}) {
  const ms = data.selected, head = el('div', 'ms-head');
  if (showProject) head.append(el('span', 'ms-proj', data.project));

  const pick = el('details', 'ms-pick'), menu = el('div', 'ms-menu');
  pick.append(el('summary', null, ms ? ms.title : 'Pick a milestone'), menu);
  menu.append(...data.milestones.map(m => {
    const b = el('button', ms?.title === m.title ? 'on' : null, m.title);
    if (data.detected.includes(m.title)) b.append(el('small', null, 'your MRs'));
    else if (m.due) b.append(el('small', null, due(m.due)));
    b.onclick = () => { pick.open = false; onPick?.(m.title); };
    return b;
  }));
  head.append(pick);
  if (!ms) return container.replaceChildren(head);

  const bar = el('div', 'ms-bar'), fill = el('b');
  fill.style.width = `${ms.total ? Math.round(100 * ms.closed / ms.total) : 0}%`;
  bar.append(fill);
  bar.title = `${ms.closed} of ${ms.total} issues closed`;
  const link = el('a', 'ms-count', due(ms.due)); link.href = ms.url; link.target = '_blank'; link.rel = 'noopener';
  head.append(link, bar, el('span', 'ms-count', `${ms.closed}/${ms.total} closed`));
  for (const [k, label] of Object.entries(SHORT)) {
    const n = ms.groups[k].length;
    if (n) head.append(el('span', `ms-count${k === 'closable' ? ' hot' : ''}`, `${n} ${label}`));
  }

  const more = el('button', 'quiet ms-more', expanded.has(data.project) ? '▴' : '▾');
  more.title = more.ariaLabel = expanded.has(data.project) ? 'Hide issues' : 'Show issues';
  more.onclick = () => { expanded.has(data.project) ? expanded.delete(data.project) : expanded.add(data.project); renderMilestone(container, data, { onPick, showProject }); };
  head.append(more);
  if (!expanded.has(data.project)) return container.replaceChildren(head);

  const body = el('div', 'ms-body'), prefix = new RegExp(`^${ms.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( v\\d+)?:\\s*`, 'i');
  for (const [k, label] of GROUPS) {
    const list = ms.groups[k];
    if (!list.length) continue;
    const chips = el('div', 'ms-chips');
    chips.append(...list.map(i => {
      // the assignee goes first so a long, truncated title can't hide it
      const a = el('a', `chip${k === 'closable' ? ' hot' : k === 'done' ? ' done' : ''}`, `#${i.iid} `);
      if (k !== 'done' && i.assignees.length) a.append(el('b', 'who', `${i.assignees.map(n => n.split(' ')[0]).join(', ')} · `));
      a.append(i.title.replace(prefix, ''));
      a.href = i.url; a.target = '_blank'; a.rel = 'noopener';
      a.title = [i.title, i.assignees.length ? `Assigned: ${i.assignees.join(', ')}` : 'Unassigned', ...i.mrs.map(m => `!${m.iid} ${m.state}`)].join('\n');
      return a;
    }));
    if (k !== 'done') {
      body.append(el('h5', null, `${label} · ${list.length}`), chips);
      continue;
    }
    const fold = el('details'), sum = el('summary');
    sum.append(el('h5', null, `${label} · ${list.length}`));
    fold.open = doneOpen.has(data.project);
    fold.ontoggle = () => { fold.open ? doneOpen.add(data.project) : doneOpen.delete(data.project); };
    fold.append(sum, chips);
    body.append(fold);
  }
  container.replaceChildren(head, body);
}

// Keeps one strip per project in root: the selected project, or with "All" every tracked project that has an active milestone.
// scope() returns { tracked, project } from the page's state. The chosen milestone per project is kept in localStorage.
export function mountMilestones(root, scope) {
  const style = el('style', null, CSS);
  document.head.append(style);
  const strips = new Map(); // project -> { box, json, at, title, pending }

  async function load(p, s) {
    const title = store.get(`milestone:${p}`) ?? '';
    if (s.pending || (s.title === title && Date.now() - s.at < FETCH_MS)) return;
    s.pending = true;
    try {
      const r = await fetch(`/api/milestones?project=${encodeURIComponent(p)}&milestone=${encodeURIComponent(title)}`);
      s.json = r.ok ? await r.text() : null;
    } catch {
      s.json = null;
    } finally {
      Object.assign(s, { at: Date.now(), title, pending: false });
    }
  }

  async function tick() {
    const { tracked, project } = scope(), all = project === 'all';
    const projects = all ? [...tracked].sort((a, b) => a.localeCompare(b)) : [project];
    await Promise.all(projects.map(p => {
      if (!strips.has(p)) strips.set(p, { box: el('div', 'ms-strip'), at: 0 });
      return load(p, strips.get(p));
    }));
    const shown = projects.filter(p => {
      const s = strips.get(p), data = s.json && JSON.parse(s.json);
      if (!data?.milestones.length || (all && !data.selected)) return false;
      const key = `${s.json}|${all}`;
      if (s.drawn !== key) { // redraw only on change, so an open picker or selection survives
        s.drawn = key;
        renderMilestone(s.box, data, { showProject: all, onPick: t => { store.set(`milestone:${p}`, t); tick(); } });
      }
      return true;
    }).map(p => strips.get(p).box);
    if (shown.length !== root.children.length || shown.some((b, i) => root.children[i] !== b)) root.replaceChildren(...shown);
    root.hidden = !shown.length;
  }

  tick();
  setInterval(tick, 3000);
}
