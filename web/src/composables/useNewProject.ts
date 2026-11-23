import { computed, ref, shallowRef } from 'vue';
import { api, hooks } from 'old/core.js';
import { nameError } from '@/lib/projectName';

export type Mode = 'new' | 'gh' | 'open';
export interface Step { id: string; label: string; state: string }
export interface Repo { name: string; description: string; isPrivate: boolean; updatedAt: string; local: boolean; dir: string }
export interface LocalDir { dir: string; name: string; updated: number }
/** null while loading, an Error when it failed */
export type Loaded<T> = T[] | Error | null;

const FALLBACK = { owner: '', baseDir: '~/Projects', private: true };

const shown = ref(false);
const mode = ref<Mode>('new');
const name = ref('');
const description = ref('');
const priv = ref(true);
const filter = ref('');
const config = ref(FALLBACK);
const busy = ref(false);
const error = ref('');
const steps = ref<Step[] | null>(null);
const repos = shallowRef<Loaded<Repo>>(null); // the owner's GitHub list
const local = shallowRef<Loaded<LocalDir>>(null); // the folders under baseDir

const trimmed = computed(() => name.value.trim());
const hint = computed(() => nameError(trimmed.value));

async function getJson<T>(path: string): Promise<T | Error> {
    try {
        const r = await api(path);
        if (!r.ok) {
            throw new Error(await r.text());
        }

        return await r.json();
    } catch (e) {
        return e as Error;
    }
}

async function setMode(m: Mode) {

    mode.value = m;
    if (m === 'gh' && !Array.isArray(repos.value)) {
        repos.value = null;
        repos.value = await getJson<Repo[]>('/api/projects/github');
    }
    if (m === 'open' && !Array.isArray(local.value)) {
        local.value = null;
        local.value = await getJson<LocalDir[]>('/api/projects/local');
    }
}

// ponytail: one request, so the steps show "running" on the first and fill in when the server answers; stream them if it ever feels slow
async function submit(path: string, payload: object, plan: string[][]) {

    busy.value = true;
    error.value = '';
    steps.value = plan.map(([id, label], i) => ({ id, label, state: i ? 'pending' : 'running' }));
    try {
        const r = await api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await r.text();
        let d = null;
        try {
            d = JSON.parse(text);
        } catch {}
        if (d?.steps) {
            steps.value = d.steps;
        }
        if (!r.ok || !d?.ok) {
            throw new Error(d?.error ?? text ?? 'failed');
        }
        shown.value = false;
        hooks.projectCreated?.(d);
    } catch (e) {
        error.value = (e as Error).message;
        steps.value = steps.value?.map(s => (s.state === 'running' ? { ...s, state: 'failed' } : s)) ?? null; // a request that never got an answer
    }
    busy.value = false;
}

const CHAT = ['chat', 'Starting chat'], CLONE = [['clone', 'Cloning'], CHAT];

/** Opens the "New project" dialog on a tab: a fresh repo, a clone of one of your GitHub repos, or a folder that is already there. */
export async function openNewProject(m: Mode = 'new') {

    name.value = description.value = filter.value = error.value = '';
    steps.value = null;
    busy.value = false;
    config.value = FALLBACK;
    repos.value = local.value = null;
    priv.value = FALLBACK.private;
    setMode(m);
    shown.value = true;

    try {
        const c = await api('/api/projects/config').then(r => r.json());
        config.value = c;
        priv.value = c.private;
    } catch {}
}

/** The dialog's state: what is typed, the lists of repos and folders, and the steps of a create, clone or open in progress. */
export function useNewProject() {

    const note = computed(() => `Creates github.com/${config.value.owner || '<you>'}/${trimmed.value || '<name>'}, clones it to ${config.value.baseDir}/${trimmed.value || '<name>'} and starts a Claude chat there.`);
    const filtered = computed(() => {

        const q = filter.value.trim().toLowerCase();

        return Array.isArray(repos.value) ? repos.value.filter(r => !q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) : [];
    });

    return {
        shown, mode, name, description, priv, filter, busy, error, steps, repos, local, hint, note, filtered,
        baseDir: computed(() => config.value.baseDir),
        canCreate: computed(() => !busy.value && !!trimmed.value && !hint.value),
        setMode,
        /** Typing a name clears a refused one's error and steps. */
        typed() {
            if (!busy.value) {
                error.value = '';
                steps.value = null;
            }
        },
        create() {
            return submit('/api/projects/new', { name: trimmed.value, description: description.value.trim(), private: priv.value }, [['repo', 'Creating repo'], ...CLONE]);
        },
        clone: (repo: string) => submit('/api/projects/clone', { name: repo }, CLONE),
        openDir: (dir: string) => submit('/api/projects/open', { dir }, [CHAT])
    };
}
