// Work rows the user moved to another group by hand (POST /api/pins). In pins.json in the Homebase dir, so every device
// agrees. items.mjs shows a pinned row in its group until the row's computed state (its fingerprint) changes, then drops the pin.
// The newest MAX are kept.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pins, KINDS } from './items.mjs';
import { keepAside } from './account.mjs';

const MAX = 500;
const KEY = /^[^\0-\x1f]{1,512}$/; // a row's key: an MR's URL or an agent id
const COLUMNS = new Set(Object.values(KINDS).map(k => k.column));
const ok = e => Array.isArray(e) && KEY.test(e[0]) && COLUMNS.has(e[1]?.column) && typeof e[1].fp === 'string';

function keep(entries) {

    pins.clear();
    for (const [key, pin] of entries) {
        pins.set(key, pin);
    }
}

// At server start: what was saved, or nothing when the file is missing or broken (a broken one is logged and set aside).
export function loadPins(dir) {

    let saved;
    try {
        saved = JSON.parse(readFileSync(join(dir, 'pins.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'pins.json'), e.message, 'pinned rows may move back');
        }
    }
    keep(Array.isArray(saved) ? saved.filter(ok).slice(-MAX) : []);
}

// key: the row's key; column: where to show it, or 'auto' to drop the pin; fp: the row's `fp` the user saw. Throws 400 for bad input.
export async function pin(dir, key, column, fp) {

    const bad = !KEY.test(key ?? '') || (column !== 'auto' && (!COLUMNS.has(column) || typeof fp !== 'string' || !fp || fp.length > 1000));
    if (bad) {
        throw Object.assign(new Error('expected a row key, a column (or auto) and the row\'s fp'), { status: 400 });
    }
    const rest = [...pins].filter(([k]) => k !== key);
    const next = (column === 'auto' ? rest : [...rest, [key, { column, fp }]]).slice(-MAX);

    const file = join(dir, 'pins.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600 });
    await rename(tmp, file);
    keep(next);
}
