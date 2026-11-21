// "New project…" dialog: name (validated live), description, private switch; Create posts to /api/projects/new and shows the steps.
// Its other tabs clone one of your GitHub repos, or start a chat in a folder that is already there (/api/projects/open).
import { $, el, api, ago } from './core.js';

// Mirrors the server's rule (server/newproject.mjs); the server checks again.
/** @param {string} n @returns {string} the problem, or '' */
export const nameError = n => (!n ? '' : n.length > 100 ? 'At most 100 characters' : n.startsWith('.') ? "Can't start with a dot" : /^[A-Za-z0-9._-]+$/.test(n) ? '' : 'Use letters, digits, ".", "_" and "-"');

const FALLBACK = { owner: '', baseDir: '~/Projects', private: true };
let clone = (/** @type {string} */ _name) => {}, openDir = (/** @type {string} */ _dir) => {}, cfg = FALLBACK, busy = false;
let repos = null, local = null; // the owner's GitHub list and the folders under baseDir once loaded, an Error when one failed

const setNote = () => {
    const n = $('np-name').value.trim() || '<name>';
    $('np-note').textContent = `Creates github.com/${cfg.owner || '<you>'}/${n}, clones it to ${cfg.baseDir}/${n} and starts a Claude chat there.`;
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
    renderLocal();
};

const updated = iso => { const a = ago(Date.parse(iso)); return a === 'now' ? 'updated just now' : `updated ${a} ago`; };
function renderRepos() {
    const q = /** @type {any} */ ($('np-filter')).value?.trim().toLowerCase() ?? '';
    const list = Array.isArray(repos) ? repos.filter(r => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : [];
    $('np-repos').replaceChildren(...(!repos ? [el('div', 'd-empty', 'Loading…')] : !Array.isArray(repos) ? [el('div', 'd-empty', repos.message)] : !list.length ? [el('div', 'd-empty', 'No repos match.')] : list.map(r => {
        const b = el('button', 'np-repo');
        b.type = 'button';
        b.dataset.repo = r.name;
        b.disabled = busy;
        const name = el('b', null, `${r.name}${r.isPrivate ? ' · private' : ''}`);
        if (r.local) {
            name.append(el('i', 'np-open', 'Open'));
        }
        b.append(name, el('span', null, r.local ? 'already cloned' : [r.description, updated(r.updatedAt)].filter(Boolean).join(' · ')));
        b.onclick = () => (r.local ? openDir(r.dir) : clone(r.name));
        return b;
    })));
}
const used = ms => { const a = ago(ms); return a === 'now' ? 'used just now' : `used ${a} ago`; };
function renderLocal() {
    $('np-dirs').replaceChildren(...(!local ? [el('div', 'd-empty', 'Loading…')] : !Array.isArray(local) ? [el('div', 'd-empty', local.message)] : !local.length ? [el('div', 'd-empty', `No git repos without a running chat in ${cfg.baseDir}.`)] : local.map(r => {
        const b = el('button', 'np-repo');
        b.type = 'button';
        b.dataset.dir = r.dir;
        b.disabled = busy;
        b.append(el('b', null, r.name), el('span', null, used(r.updated)));
        b.onclick = () => openDir(r.dir);
        return b;
    })));
}
/** @param {string} path @returns {Promise<any>} */
const getJson = async path => {
    try {
        const r = await api(path);
        if (!r.ok) {
            throw new Error(await r.text());
        }
        return await r.json();
    } catch (e) {
        return e;
    }
};
/** @param {'new' | 'gh' | 'open'} m */
async function setMode(m) {
    for (const t of ['new', 'gh', 'open']) {
        $(`np-${t}`).hidden = m !== t;
        $(`np-tab-${t}`).setAttribute('appearance', m === t ? 'accent' : 'outlined');
    }
    $('np-go').hidden = m !== 'new';
    $('new-dlg').setAttribute('label', m === 'open' ? 'Open a project' : 'New project');
    if (m === 'gh' && !Array.isArray(repos)) {
        repos = null;
        renderRepos();
        repos = await getJson('/api/projects/github');
        renderRepos();
    }
    if (m === 'open' && !Array.isArray(local)) {
        local = null;
        renderLocal();
        local = await getJson('/api/projects/local');
        renderLocal();
    }
}

/** @param {'new' | 'open'} [mode] */
export async function openNewProject(mode = 'new') {
    $('np-name').value = '';
    $('np-desc').value = '';
    $('np-steps').hidden = true;
    $('np-err').textContent = '';
    setBusy(false);
    cfg = FALLBACK;
    repos = null;
    local = null;
    /** @type {any} */ ($('np-filter')).value = '';
    setMode(mode);
    $('np-private').checked = cfg.private;
    validate();
    $('new-dlg').open = true;
    try {
        const c = await api('/api/projects/config').then(r => r.json());
        cfg = c;
        $('np-private').checked = c.private;
        setNote();
        renderLocal();
    } catch {}
}

/** @param {(p: { name: string, dir: string, sessionId: string | null, tmux?: string }) => void} onCreated */
export function initNewProject(onCreated) {

    $('np-name').addEventListener('input', () => {
        if (!busy) { // a refused name's error and steps go once the name is edited
            $('np-err').textContent = '';
            $('np-steps').hidden = true;
        }
        validate();
    });
    $('np-form').addEventListener('submit', e => {
        e.preventDefault();
        if (!$('np-go').disabled) {
            create();
        }
    });
    $('np-go').onclick = () => create();
    $('np-tab-new').onclick = () => setMode('new');
    $('np-tab-gh').onclick = () => setMode('gh');
    $('np-tab-open').onclick = () => setMode('open');
    $('np-filter').addEventListener('input', renderRepos);

    const CHAT = ['chat', 'Starting chat'], CLONE = [['clone', 'Cloning'], CHAT];
    const create = () => submit('/api/projects/new', { name: $('np-name').value.trim(), description: $('np-desc').value.trim(), private: $('np-private').checked }, [['repo', 'Creating repo'], ...CLONE]);
    clone = (/** @type {string} */ name) => submit('/api/projects/clone', { name }, CLONE);
    openDir = (/** @type {string} */ dir) => submit('/api/projects/open', { dir }, [CHAT]);

    // ponytail: one request, so the steps show "running" on the first and fill in when the server answers; stream them if it ever feels slow
    async function submit(path, payload, steps) {
        setBusy(true);
        $('np-err').textContent = '';
        renderSteps(steps.map(([id, label], i) => ({ id, label, state: i ? 'pending' : 'running' })));
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
