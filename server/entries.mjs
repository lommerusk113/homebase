// Transcript reading: the projects root, live Claude Code sessions, tail reading and its mtime cache, entry cleanup and text helpers.
import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OUR_TMUX } from './tmux.mjs';

export const ROOT = join(homedir(), '.claude', 'projects');
// The project folders under ROOT; none when Claude Code never ran on this machine.
export const projectDirs = () => readdir(ROOT).catch(e => (e.code === 'ENOENT' ? [] : Promise.reject(e)));
// ponytail: only the tail is parsed (transcripts reach 70+ MB); subagent token totals use the offset reader below
const TAIL_BYTES = 512 * 1024;
const TAIL_MIN_LINES = 200;
export const TAIL_MAX_BYTES = 16 * 1024 * 1024;

export const cache = new Map(); // path -> { mtimeMs, entries }

// Session ids held by a running Claude Code, from the registry it keeps in ~/.claude/sessions/<pid>.json (it follows
// /clear and --resume), as a Map id -> its tmux session name ("tmux": "cc-x:@0.%0") or null outside tmux, or when two
// live processes hold the id in different places; null when there is no registry (older Claude Code), so nothing is inferred.
// Held in two or more of Homebase's own cc-* tmux sessions, the newest process (startedAt) wins and the others go in live.twice.
// ponytail: liveness is kill(pid, 0); a reused pid keeps a dead session "live", which is the old behaviour. "tmux" is undocumented
export async function liveSessions(dir = join(homedir(), '.claude', 'sessions')) {

    let names;
    try {
        names = (await readdir(dir)).filter(f => /^\d+\.json$/.test(f));
    } catch {
        return null;
    }

    // busy: registry status "busy"; started: sessionId -> process start (ms); twice: sessionId -> the older cc-* tmux names
    const live = Object.assign(new Map(), { busy: new Set(), started: new Map(), twice: new Map() });
    const procs = new Map(); // sessionId -> [{ t, startedAt }]
    for (const name of names) {
        try {
            const { pid, sessionId, tmux, status, startedAt } = JSON.parse(await readFile(join(dir, name), 'utf8'));
            if (alive(pid)) {
                const t = typeof tmux === 'string' ? tmux.split(':')[0] || null : null;
                procs.set(sessionId, [...(procs.get(sessionId) ?? []), { t, startedAt: startedAt ?? 0 }]);
                if (status === 'busy') {
                    live.busy.add(sessionId);
                }
            }
        } catch {
            continue; // half-written or removed as the process exits
        }
    }

    for (const [id, ps] of procs) {
        ps.sort((a, b) => b.startedAt - a.startedAt);
        const names = [...new Set(ps.map(p => p.t))];
        const ours = names.every(t => t && OUR_TMUX.test(t));
        live.set(id, names.length === 1 || ours ? ps[0].t : null);
        if (names.length > 1 && ours) {
            live.twice.set(id, names.slice(1));
        }
        if (ps[0].startedAt) {
            live.started.set(id, ps[0].startedAt);
        }
    }

    return live;
}

function alive(pid) {

    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM'; // exists, owned by someone else
    }
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = v => typeof v === 'string';
const dropUnless = (o, keys, ok) => keys.forEach(k => {
    if (k in o && !ok(o[k])) {
        delete o[k];
    }
});

// A parsed transcript line in the shape every reader here assumes, so one odd line never throws in them: an object,
// its ids and paths strings, its content blocks objects, a tool call's input an object with string paths and commands
// and well-formed questions. A field of another type is dropped; null for a line that is no object.
export function cleanEntry(e) {

    if (!isObj(e)) {
        return null;
    }
    dropUnless(e, ['cwd', 'sessionId', 'gitBranch', 'prUrl', 'aiTitle'], isString);
    dropUnless(e, ['message', 'attachment'], isObj);
    if (Array.isArray(e.message?.content)) {
        e.message.content = e.message.content.filter(isObj);
        for (const b of e.message.content.filter(b => b.type === 'tool_use')) {
            b.input = isObj(b.input) ? b.input : {};
            dropUnless(b.input, ['file_path', 'command', 'description', 'prompt'], isString);
            dropUnless(b.input, ['questions'], Array.isArray);
            b.input.questions &&= b.input.questions.filter(isObj)
                .map(q => ({ ...q, question: String(q.question ?? ''), options: Array.isArray(q.options) ? q.options.filter(isObj) : [] }));
        }
    }

    return e;
}

// A few huge lines (tool results, api-request blobs of ~1 MB) can fill the byte tail on their own, and one long turn
// can outrun it, so it grows until it holds TAIL_MIN_LINES lines and a turn start, the whole file or `cap` bytes.
// ponytail: a transcript with no turn markers (older Claude Code) is read up to `cap` on every change
export const readTail = async (path, size, max, cap) => (await readTailInfo(path, size, max, cap)).entries;

// readTail plus bytes (how far back it read) and cut (the file starts before that).
export async function readTailInfo(path, size, max = TAIL_BYTES, cap = TAIL_MAX_BYTES) {

    const fh = await open(path, 'r');
    try {
        let len = Math.min(size, max), lines;
        for (;;) {
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            const text = buf.toString('utf8');
            lines = text.split('\n');
            if (len < size) {
                lines.shift(); // partial first line
            }
            if ((lines.length >= TAIL_MIN_LINES && text.includes('"turnPosition":{')) || len >= size || len >= cap) {
                break;
            }
            len = Math.min(size, len * 2);
        }

        const entries = lines.flatMap(l => {
            try {
                return l ? [cleanEntry(JSON.parse(l))].filter(Boolean) : [];
            } catch {
                return [];
            }
        });

        return { entries, bytes: len, cut: len < size };
    } finally {
        await fh.close();
    }
}

export async function tailOf(path, st) {

    let hit = cache.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
        hit = { mtimeMs: st.mtimeMs, ...await readTailInfo(path, st.size) };
        cache.set(path, hit);
    }

    return hit.entries;
}

export function textOf(entry) {

    const c = entry?.message?.content;
    if (typeof c === 'string') {
        return c;
    }

    return Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
}

// Text Claude Code writes as a user line: a hyphenated tag first (<task-notification>, <command-name>, <bash-input>,
// <local-command-stdout>, <agent-message>, <system-reminder>…). A prompt that merely starts with "<" is still the user's.
const SYSTEM_TEXT = /^<[a-z]+-[\w-]*[\s/>]/;
export const isSystemText = t => SYSTEM_TEXT.test(t.trimStart());

export function isHumanPrompt(e) {
    return e.type === 'user' && !e.isMeta && !e.isCompactSummary && !e.isSidechain && !!textOf(e) && !isSystemText(textOf(e));
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Files Claude edited, newest first, from tool calls in the parsed tail.
export function filesTouched(entries, cwd) {

    const paths = entries
        .filter(e => e.type === 'assistant' && Array.isArray(e.message?.content))
        .flatMap(e => e.message.content)
        .filter(b => b.type === 'tool_use' && EDIT_TOOLS.has(b.name))
        .map(b => b.input?.file_path ?? b.input?.notebook_path)
        .filter(Boolean)
        .map(f => (cwd && f.startsWith(cwd + '/') ? f.slice(cwd.length + 1) : f));

    return [...new Set(paths.reverse())].slice(0, 20);
}

export const PR_URL = /https:\/\/[^\s)>\]`'"]+?\/(?:-\/merge_requests|pull)\/\d+/g;

// Multi-line pastes are stored as `<pasted_content id="x">…</pasted_content id="x">`; show only what was typed.
const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;
export const unwrapPasted = s => (typeof s === 'string' ? s.replace(PASTED, '$2').trim() : '');
export const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/;
