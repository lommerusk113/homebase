// Persistent record of the MRs/PRs Homebase has seen (plain JSON, ~/.claude/homebase/items.json), so a work item
// survives its pr-link scrolling out of a transcript tail. Deleting the file is safe: it refills from transcripts and the forge.
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sameRepo } from './items.mjs';
import { keepAside } from './account.mjs';

export const STORE_FILE = join(process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase'), 'items.json');
const PRUNE_MS = 30 * 864e5;
const WRITE_GAP_MS = 10_000;

// { file, data: { project: { url: entry } }, dirty, writtenAt }. A corrupt file is logged and moved to .bak.
export function loadStore(file = STORE_FILE) {

    const store = { file, data: {}, dirty: false, writtenAt: 0 };
    let text;
    try {
        text = readFileSync(file, 'utf8');
    } catch {
        return store; // first start
    }
    try {
        const data = JSON.parse(text);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('not an object');
        }
        // entries filed under another repo's project (an MR a session only quoted) don't belong; nor does anything that is no object
        const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
        for (const [project, urls] of Object.entries(data)) {
            if (!isObj(urls)) {
                delete data[project];
                store.dirty = true;
                continue;
            }
            for (const url of Object.keys(urls)) {
                if (!isObj(urls[url]) || !sameRepo(url, project)) {
                    delete urls[url];
                    store.dirty = true;
                }
            }
        }
        store.data = data; // only once it is known good: a half-checked file must not stay in memory
    } catch (e) {
        keepAside(file, e.message, 'starting empty');
    }

    return store;
}

const stale = (e, now) => now - e.lastSeen > PRUNE_MS;
const sameEntry = (a, b) => JSON.stringify({ ...a, lastSeen: 0 }) === JSON.stringify({ ...b, lastSeen: 0 });

// Notes every work item that has an MR: its title, issue, branch, session, state and finished agents. lastSeen alone never triggers a write.
export function record(store, items, now = Date.now()) {

    for (const it of items.filter(i => i.pr)) {
        const projectData = store.data[it.project] ??= {};
        const old = projectData[it.pr];
        const state = it.prState?.state ?? old?.state ?? null;
        const agents = new Map((old?.agents ?? []).map(a => [a.id, a]));
        for (const a of it.agentLinks ?? []) {
            agents.set(a.id, a);
        }
        const next = {
            title: it.prState?.title ?? old?.title ?? it.title,
            issue: it.prState?.issue ?? old?.issue ?? null,
            branch: it.branch ?? old?.branch ?? null,
            sessionId: it.sessionId ?? old?.sessionId ?? null,
            firstSeen: old?.firstSeen ?? now,
            lastSeen: it.prState ? now : old?.lastSeen ?? now, // confirmed by the forge, so an MR it can't read any more ages out
            state,
            mergedAt: state === 'merged' ? old?.mergedAt ?? now : old?.mergedAt ?? null,
            agents: [...agents.values()]
        };
        projectData[it.pr] = next;
        store.dirty ||= !old || !sameEntry(old, next);
    }

    // entries the forge hasn't confirmed for 30 days: merged/closed ones, and open ones it can't read any more
    for (const [project, urls] of Object.entries(store.data)) {
        for (const [url, e] of Object.entries(urls)) {
            if (stale(e, now)) {
                delete urls[url];
                store.dirty = true;
            }
        }
        if (!Object.keys(urls).length) {
            delete store.data[project];
        }
    }
}

// The stored MRs still worth a row: open, or merged within windowMs, as { url, project, sessionId, agents } seeds.
export function seeds(store, now, windowMs) {

    return Object.entries(store.data).flatMap(([project, urls]) => Object.entries(urls)
        .filter(([, e]) => e.state === 'open' || (e.state === 'merged' && now - (e.mergedAt ?? e.lastSeen) < windowMs))
        .map(([url, e]) => ({ url, project, sessionId: e.sessionId, agents: e.agents ?? [] })));
}

// Writes when something changed and the last write was 10 s ago: temp file + rename, mode 0600. Entries another
// Homebase wrote since are kept, unless ours are newer or they are stale.
// ponytail: read-merge-write without a lock; two flushes racing can still drop the other's newest change until it writes again
export function flush(store, now = Date.now()) {

    if (!store.dirty || now - store.writtenAt < WRITE_GAP_MS) {
        return;
    }
    store.writtenAt = now;
    try {
        mkdirSync(dirname(store.file), { recursive: true, mode: 0o700 });
        for (const [project, urls] of Object.entries(loadStore(store.file).data)) {
            for (const [url, e] of Object.entries(urls ?? {})) {
                const mine = store.data[project]?.[url];
                if (!stale(e, now) && (!mine || e.lastSeen > mine.lastSeen)) {
                    (store.data[project] ??= {})[url] = e;
                }
            }
        }
        const tmp = `${store.file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(store.data, null, 1), { mode: 0o600 });
        renameSync(tmp, store.file);
        store.dirty = false;
    } catch (e) {
        console.error(`could not write ${store.file}: ${e.message}`); // retried after the gap
    }
}
