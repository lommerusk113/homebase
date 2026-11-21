// The projects on the board (GET/POST /api/tracked), in tracked.json in the Homebase dir. On the server rather than in
// each browser's localStorage, so a paired phone (another origin, so other storage) shows the same projects as the Mac.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { keepAside } from './account.mjs';

const MAX = 500;

// The saved list, or null when none was saved yet (a browser then hands over its own list).
export async function readTracked(dir) {

    try {
        const list = JSON.parse(await readFile(join(dir, 'tracked.json'), 'utf8'));
        return validTracked(list) ? list : null;
    } catch (e) {
        if (e.code !== 'ENOENT') { // broken: set aside, so the next browser's list is not taken silently
            keepAside(join(dir, 'tracked.json'), e.message, 'the board takes the next browser\'s project list');
        }
        return null;
    }
}

export const validTracked = list => Array.isArray(list) && list.length <= MAX
    && list.every(p => typeof p === 'string' && p.length > 0 && p.length <= 200);

// body: the JSON array a page posts. Throws 400 for anything else.
export async function saveTracked(dir, body) {

    let list;
    try {
        list = JSON.parse(body);
    } catch {}
    if (!validTracked(list)) {
        throw Object.assign(new Error('expected a JSON array of project names'), { status: 400 });
    }

    const file = join(dir, 'tracked.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify([...new Set(list)]), { mode: 0o600 });
    await rename(tmp, file);
}
