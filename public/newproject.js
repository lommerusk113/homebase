// "New project…" dialog: name (validated live), description, private switch; Create posts to /api/projects/new and shows the steps.
import { $, el, api, ago } from './core.js';

// Mirrors the server's rule (server/newproject.mjs); the server checks again.
/** @param {string} n @returns {string} the problem, or '' */
export const nameError = n => (!n ? '' : n.length > 100 ? 'At most 100 characters' : n.startsWith('.') ? "Can't start with a dot" : /^[A-Za-z0-9._-]+$/.test(n) ? '' : 'Use letters, digits, ".", "_" and "-"');

const FALLBACK = { owner: 'lommerusk113', baseDir: '~/IdeaProjects/Privat', private: true };
let clone = (/** @type {string} */ _name) => {}, cfg = FALLBACK, busy = false, repos = null; // repos: the owner's GitHub list once loaded, an Error when it failed

const setNote = () => {
    const n = $('np-name').value.trim() || '<name>';
    $('np-note').textContent = `Creates github.com/${cfg.owner}/${n}, clones it to ${cfg.baseDir}/${n} and starts a Claude chat there.`;
};
function validate() {
    const n = $('np-name').value.trim(), err = nameError(n);
    $('np-name').hint = err;
    $('np-name').toggleAttribute('data-invalid', !!err);
    $('np-go').disabled = busy || !n || !!err;
    setNote();
}
/** @param {{ id: string, label: string, state: string }[]} steps */
const renderSteps = steps => {
    $('np-steps').hidden = false;
    $('np-steps').replaceChildren(...steps.map(s => {
        const li = el('li', s.state, s.label);
        li.dataset.step = s.id;
        return li;
    }));
};
const setBusy = b => {
    busy = b;
    for (const id of ['np-name', 'np-desc', 'np-private', 'np-filter']) {
        /** @type {any} */ ($(id)).disabled = b;
    }
    validate();
    renderRepos();
};

const updated = iso => { const a = ago(Date.parse(iso)); return a === 'now' ? 'updated just now' : `updated ${a} ago`; };
function renderRepos() {
    const q = /** @type {any} */ ($('np-filter')).value?.trim().toLowerCase() ?? '';
    const list = Array.isArray(repos) ? repos.filter(r => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : [];
    $('np-repos').replaceChildren(...(!repos ? [el('div', 'd-empty', 'Loading…')] : !Array.isArray(repos) ? [el('div', 'd-empty', repos.message)] : !list.length ? [el('div', 'd-empty', 'No repos match.')] : list.map(r => {
        const b = el('button', 'np-repo');
        b.type = 'button';
        b.dataset.repo = r.name;
        b.disabled = busy || r.local;
        b.append(el('b', null, `${r.name}${r.isPrivate ? ' · private' : ''}`), el('span', null, r.local ? 'already cloned' : [r.description, updated(r.updatedAt)].filter(Boolean).join(' · ')));
        b.onclick = () => clone(r.name);
        return b;
    })));
}
async function setMode(m) {
    $('np-new').hidden = m !== 'new';
    $('np-gh').hidden = m !== 'gh';
    $('np-go').hidden = m !== 'new';
    $('np-tab-new').setAttribute('appearance', m === 'new' ? 'accent' : 'outlined');
    $('np-tab-gh').setAttribute('appearance', m === 'gh' ? 'accent' : 'outlined');
    if (m === 'gh' && !Array.isArray(repos)) {
        repos = null;
        renderRepos();
        try {
            const r = await api('/api/projects/github');
            if (!r.ok) {
                throw new Error(await r.text());
            }
            repos = await r.json();
        } catch (e) {
            repos = e;
        }
        renderRepos();
    }
}

export async function openNewProject() {
    $('np-name').value = '';
    $('np-desc').value = '';
    $('np-steps').hidden = true;
    $('np-err').textContent = '';
    setBusy(false);
    cfg = FALLBACK;
    repos = null;
    /** @type {any} */ ($('np-filter')).value = '';
    setMode('new');
    $('np-private').checked = cfg.private;
    validate();
    $('new-dlg').open = true;
    try {
        const c = await api('/api/projects/config').then(r => r.json());
        cfg = c;
        $('np-private').checked = c.private;
        setNote();
    } catch {}
}

/** @param {(p: { name: string, dir: string, sessionId: string | null, tmux?: string }) => void} onCreated */
export function initNewProject(onCreated) {

    $('np-name').addEventListener('input', validate);
    $('np-form').addEventListener('submit', e => {
        e.preventDefault();
        if (!$('np-go').disabled) {
            create();
        }
    });
    $('np-go').onclick = () => create();
    $('np-tab-new').onclick = () => setMode('new');
    $('np-tab-gh').onclick = () => setMode('gh');
    $('np-filter').addEventListener('input', renderRepos);

    const create = () => submit('/api/projects/new', { name: $('np-name').value.trim(), description: $('np-desc').value.trim(), private: $('np-private').checked }, true);
    clone = (/** @type {string} */ name) => submit('/api/projects/clone', { name }, false);

    // ponytail: one request, so the steps show "running" on the first and fill in when the server answers; stream them if it ever feels slow
    async function submit(path, payload, withRepo) {
        setBusy(true);
        $('np-err').textContent = '';
        renderSteps([...(withRepo ? [{ id: 'repo', label: 'Creating repo', state: 'pending' }] : []), { id: 'clone', label: 'Cloning', state: 'pending' }, { id: 'chat', label: 'Starting chat', state: 'pending' }].map((s, i) => i ? s : { ...s, state: 'running' }));
        try {
            const r = await api(path, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const text = await r.text();
            let d = null;
            try {
                d = JSON.parse(text);
            } catch {}
            if (d?.steps) {
                renderSteps(d.steps);
            }
            if (!r.ok || !d?.ok) {
                throw new Error(d?.error ?? text ?? 'failed');
            }
            $('new-dlg').open = false;
            onCreated(d);
        } catch (e) {
            $('np-err').textContent = e.message;
            $('np-steps').querySelectorAll('.running').forEach(li => li.classList.add('failed')); // a request that never got an answer
        }
        setBusy(false);
    }
}
