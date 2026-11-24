// Token saver: when on, chats Homebase starts run their helpers (Agent tool) on Sonnet. One file, token-saver.md in the
// Homebase dir, is both the setting and what a running chat re-reads when it goes stale (rules.mjs watches it).
import { readFileSync, existsSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SAVER_RULE = 'Token saver is on. Main chat: run at most two helpers at a time and never pass --model opus unless the user names it; batch small fixes into one helper and start queued work when a helper finishes; read-only Agent lookups use model haiku. Helper: keep steps few and command output short.';
// Earlier texts of the rule: a token-saver.md holding one still means on, and syncSaver rewrites it to the current text
const OLD_SAVER_RULES = ['Token saver is on: start every helper (Agent tool) with model: sonnet, unless the user names another model. Run at most two helpers at a time; do small jobs (a lookup, a few-line fix) yourself instead of starting a helper. Queue further work and start it when a helper finishes.'];
export const AUTO_SAVER_PERCENT = 80; // the saver turns itself on when the five-hour or weekly window is this used
export const saverRules = on => (on ? SAVER_RULE : 'Token saver is off: pick helper models as usual.');

const dir = () => process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
export const saverFile = (d = dir()) => join(d, 'token-saver.md');

export const saverOn = (d = dir()) => {
    try {
        const t = readFileSync(saverFile(d), 'utf8').trim();

        return t === SAVER_RULE || OLD_SAVER_RULES.includes(t);
    } catch {
        return false;
    }
};

let writes = 0;
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

// Every flip of token-saver.md as [time, on], newest last, so a chat is stale only when the rule differs from what it holds.
const historyFile = d => join(d, 'token-saver-history.json');
const history = d => {
    try {
        return JSON.parse(readFileSync(historyFile(d), 'utf8'));
    } catch {
        return [];
    }
};

// Whether the saver was on at `ms`; undefined when the history doesn't reach back that far (then callers fall back to mtime).
export const saverOnAt = (ms, d = dir()) => history(d).findLast(([at]) => at <= ms)?.[1];

// { on: the user's switch, auto: usage forces it on, effective: what chats get }. Writes token-saver.md (the file a running
// chat re-reads) only when the effective state changes, so "Load new rules" shows once per flip.
export async function syncSaver(lim, d = dir()) {

    const on = userOn(d);
    const used = usedPercent(lim);
    const known = [lim?.fiveHour?.used, lim?.sevenDay?.used].some(Number.isFinite);
    const autoFile = join(d, 'token-saver-auto'); // the last auto state from known limits, kept while they are unknown
    const lastAuto = () => { try { return readFileSync(autoFile, 'utf8').trim() === 'on'; } catch { return false; } };
    const auto = known ? used >= AUTO_SAVER_PERCENT : lastAuto();
    if (known && auto !== lastAuto()) {
        await mkdir(d, { recursive: true });
        await writeFile(autoFile, auto ? 'on\n' : 'off\n', { mode: 0o600 });
    }
    const effective = on || auto;

    const stale = effective && saverOn(d) && readFileSync(saverFile(d), 'utf8').trim() !== SAVER_RULE; // on, but with an old rule text
    if (effective !== saverOn(d) || !existsSync(saverFile(d)) || stale) {
        const file = saverFile(d);
        await mkdir(d, { recursive: true });
        // A tmp name per call: the client's GET poll and a POST can sync at once, and a shared tmp made the loser's rename throw ENOENT (a 500).
        const tmp = `${file}.${process.pid}.${++writes}.tmp`;
        await writeFile(tmp, `${saverRules(effective)}\n`, { mode: 0o600 });
        await rename(tmp, file);
        if (!stale) { // a rewrite to the current text is no flip
            await writeFile(historyFile(d), JSON.stringify([...history(d), [Date.now(), effective]].slice(-50)), { mode: 0o600 });
        }
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
