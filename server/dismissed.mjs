// Work rows the user dismissed (POST /api/dismissed): a helper without an MR that stopped or finished and needs nothing
// more. In dismissed.json in the Homebase dir, so every device agrees. items.mjs hides them until the helper moves again.
// The newest MAX are kept.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dismissed } from './items.mjs';
import { keepAside } from './account.mjs';

const MAX = 500;
const KEY = /^[\w-]{1,128}$/; // an agent id: never an MR's URL, whose row is not dismissed

function keep(entries) {

    dismissed.clear();
    for (const [key, at] of entries) {
        dismissed.set(key, at);
    }
}

// At server start: what was saved, or nothing when the file is missing or broken (a broken one is logged and set aside).
export function loadDismissed(dir) {

    let saved;
    try {
        saved = JSON.parse(readFileSync(join(dir, 'dismissed.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'dismissed.json'), e.message, 'dismissed rows may show again');
        }
    }
    const ok = e => Array.isArray(e) && KEY.test(e[0]) && Number.isFinite(e[1]);
    keep(Array.isArray(saved) ? saved.filter(ok).slice(-MAX) : []);
}

// key: the work item's key. Throws 400 for anything that is not an agent id.
export async function dismiss(dir, key, now = Date.now()) {

    if (!KEY.test(key ?? '')) {
        throw Object.assign(new Error('expected the key of a row without an MR'), { status: 400 });
    }
    const next = [...[...dismissed].filter(([k]) => k !== key), [key, now]].slice(-MAX);

    const file = join(dir, 'dismissed.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
    keep(next);
}
