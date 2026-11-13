// "New project…" dialog: name (validated live), description, private switch; Create posts to /api/projects/new and shows the steps.
import { $, el, api } from './core.js';

// Mirrors the server's rule (server/newproject.mjs); the server checks again.
/** @param {string} n @returns {string} the problem, or '' */
export const nameError = n => (!n ? '' : n.length > 100 ? 'At most 100 characters' : n.startsWith('.') ? "Can't start with a dot" : /^[A-Za-z0-9._-]+$/.test(n) ? '' : 'Use letters, digits, ".", "_" and "-"');

const FALLBACK = { owner: 'lommerusk113', baseDir: '~/IdeaProjects/Privat', private: true };
let cfg = FALLBACK, busy = false;

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
    for (const id of ['np-name', 'np-desc', 'np-private']) {
        /** @type {any} */ ($(id)).disabled = b;
    }
    validate();
};

export async function openNewProject() {
    $('np-name').value = '';
    $('np-desc').value = '';
    $('np-steps').hidden = true;
    $('np-err').textContent = '';
    setBusy(false);
    cfg = FALLBACK;
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

/** @param {(p: { name: string, dir: string, sessionId: string | null }) => void} onCreated */
export function initNewProject(onCreated) {

    $('np-name').addEventListener('input', validate);
    $('np-form').addEventListener('submit', e => {
        e.preventDefault();
        if (!$('np-go').disabled) {
            create();
        }
    });
    $('np-go').onclick = () => create();

    // ponytail: one request, so the steps show "running" on the first and fill in when the server answers; stream them if it ever feels slow
    async function create() {
        const name = $('np-name').value.trim();
        setBusy(true);
        $('np-err').textContent = '';
        renderSteps([{ id: 'repo', label: 'Creating repo', state: 'running' }, { id: 'clone', label: 'Cloning', state: 'pending' }, { id: 'chat', label: 'Starting chat', state: 'pending' }]);
        try {
            const r = await api('/api/projects/new', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name, description: $('np-desc').value.trim(), private: $('np-private').checked })
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
