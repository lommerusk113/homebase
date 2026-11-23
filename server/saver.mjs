// Token saver: when on, chats Homebase starts run their helpers (Agent tool) on Sonnet. One file, token-saver.md in the
// Homebase dir, is both the setting and what a running chat re-reads when it goes stale (rules.mjs watches it).
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SAVER_RULE = 'Token saver is on: start every helper (Agent tool) with model: sonnet, unless the user names another model. Run at most two helpers at a time; do small jobs (a lookup, a few-line fix) yourself instead of starting a helper. Queue further work and start it when a helper finishes.';
export const AUTO_SAVER_PERCENT = 80; // the saver turns itself on when the five-hour or weekly window is this used
export const saverRules = on => (on ? SAVER_RULE : 'Token saver is off: pick helper models as usual.');

const dir = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
export const saverFile = (d = dir()) => join(d, 'token-saver.md');

export const saverOn = (d = dir()) => {
    try {
        return readFileSync(saverFile(d), 'utf8').trim() === SAVER_RULE;
    } catch {
        return false;
    }
};

const choiceFile = d => join(d, 'token-saver-choice');
const userOn = d => {
    try {
        return readFileSync(choiceFile(d), 'utf8').trim() === 'on';
    } catch {
        return false;
    }
};

// The highest used % of the two windows from limits(), or 0 when unknown.
export const usedPercent = lim => Math.max(0, lim?.fiveHour?.used ?? 0, lim?.sevenDay?.used ?? 0);

// { on: the user's switch, auto: usage forces it on, effective: what chats get }. Writes token-saver.md (the file a running
// chat re-reads) only when the effective state changes, so "Load new rules" shows once per flip.
export async function syncSaver(lim, d = dir()) {

    const on = userOn(d);
    const used = usedPercent(lim);
    const auto = used >= AUTO_SAVER_PERCENT;
    const effective = on || auto;

    if (effective !== saverOn(d) || !existsSync(saverFile(d))) {
        const file = saverFile(d);
        await mkdir(d, { recursive: true });
        await writeFile(`${file}.tmp`, `${saverRules(effective)}\n`, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
    }

    return { on, auto, effective, used: Math.round(used) };
}

// body: JSON { on: boolean } is the user's choice. Throws 400 for anything else. Returns the state.
export async function saveSaver(body, d = dir(), lim = null) {

    let b;
    try {
        b = JSON.parse(body);
    } catch {}
    if (typeof b?.on !== 'boolean') {
        throw Object.assign(new Error('expected {on: boolean}'), { status: 400 });
    }

    await mkdir(d, { recursive: true });
    await writeFile(choiceFile(d), b.on ? 'on\n' : 'off\n', { mode: 0o600 });

    return syncSaver(lim, d);
}
