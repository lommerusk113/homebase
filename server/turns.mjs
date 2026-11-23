// Turn state: pending AskUserQuestion and permission waits (with the hooks/asking.mjs marker), closed sessions,
// working/asking/stuck/idle, the open turn's prompts and the prompts behind each Agent call.
import { stat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tmux, tmuxFor, aliases } from './tmux.mjs';
import { capture, promptBack } from './startup.mjs';
import { textOf, isHumanPrompt, unwrapPasted, INTERRUPTED } from './entries.mjs';

export const WORKING_MS = 10_000;
const TURN_STALE_MS = 30 * 60_000; // an open turn with no transcript write this long is treated as dead

// The questions of an AskUserQuestion that has no tool_result yet, as [{ question, options: [label], descriptions }], else those of
// the hook's marker (see askMarker), else null.
export function pendingAsk(entries, marker = null) {

    const ask = entries
        .filter(e => e.type === 'assistant' && !e.isSidechain && Array.isArray(e.message?.content))
        .flatMap(e => e.message.content)
        .findLast(b => b.type === 'tool_use' && b.name === 'AskUserQuestion');
    const answered = ask && entries.some(e => e.type === 'user' && Array.isArray(e.message?.content)
        && e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === ask.id));

    if (ask && !answered) {
        return (ask.input?.questions ?? []).map(q => {
            const opts = (q.options ?? []).filter(o => o.label);

            return { question: q.question ?? '', options: opts.map(o => o.label), descriptions: opts.map(o => o.description ?? '') };
        });
    }

    return markerAsk(marker, entries);
}

// The question text of a pending AskUserQuestion (or permission prompt), else null.
export function pendingQuestion(entries, marker = null) {

    const questions = pendingAsk(entries, marker);

    return questions && (questions[0]?.question || 'Claude asked a question.');
}

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKER_MAX_MS = 24 * 3600_000;
const markers = new Map(); // session id -> { mtimeMs, marker }

// The marker hooks/asking.mjs keeps while a session waits on an AskUserQuestion ({ questions, toolUseId, at }) or a
// permission prompt ({ permission, at }), else null. Claude Code can write the AskUserQuestion entry only once it is
// answered (when the same message started background agents), so the transcript alone misses that wait.
// A permission marker stays until the approved tool finishes (no hook fires on the answer): it is over as soon as the
// chat's pane shows Claude's input box again. live: liveSessions(), for the tmux a /clear'd chat runs in.
export async function askMarker(id, { live = null, tm = tmux } = {}) {

    const marker = await readMarker(id);

    const fresh = marker?.permission && Date.now() - Date.parse(marker.at) < MARKER_MAX_MS; // a stale one is ignored anyway (markerAsk)

    return fresh && promptBack(await capture(tmuxFor(id, aliases, live), tm)) ? null : marker;
}

async function readMarker(id) {

    if (!SESSION_ID.test(id ?? '')) {
        return null;
    }

    const path = join(process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase'), 'asking', `${id}.json`);
    let st;
    try {
        st = await stat(path);
    } catch {
        markers.delete(id);
        return null;
    }

    let hit = markers.get(id);
    if (hit?.mtimeMs !== st.mtimeMs) {
        let marker = null;
        try {
            marker = JSON.parse(await readFile(path, 'utf8'));
        } catch {} // gone or unreadable: none this poll
        hit = { mtimeMs: st.mtimeMs, marker };
        markers.set(id, hit);
    }

    return hit.marker;
}

// A marker's questions, unless it is older than MARKER_MAX_MS or a later transcript entry shows the wait is over: the
// answer to its AskUserQuestion (any tool result, for a permission prompt), a turn end or a new human prompt.
export function markerAsk(marker, entries, now = Date.now()) {

    const at = Date.parse(marker?.at);
    if (!at || now - at > MARKER_MAX_MS || !(marker.questions?.length || marker.permission)) {
        return null;
    }

    const over = entries.some(e => !e.isSidechain && Date.parse(e.timestamp) > at && (
        (e.type === 'system' && e.subtype === 'turn_duration')
        || isHumanPrompt(e)
        || (e.type === 'user' && Array.isArray(e.message?.content)
            && e.message.content.some(b => b.type === 'tool_result' && (marker.permission || b.tool_use_id === marker.toolUseId)))));
    if (over) {
        return null;
    }

    return marker.questions?.length
        ? marker.questions.map(q => ({ question: String(q.question ?? ''), options: (q.options ?? []).map(String) }))
        : [{ question: String(marker.permission), options: [] }];
}

// A live permission prompt that no tool of the chat's own waits on: a background helper's, which runs inside this chat's
// process and so prompts on its pane. Claude Code offers no way to answer it elsewhere. (An open Agent call is the helper itself.)
export function helperAsk(marker, entries, now = Date.now()) {

    if (!marker?.permission || !markerAsk(marker, entries, now)) {
        return false;
    }
    const mine = entries.filter(e => !e.isSidechain && Array.isArray(e.message?.content)).flatMap(e => e.message.content);
    const done = new Set(mine.filter(b => b.type === 'tool_result').map(b => b.tool_use_id));

    return !mine.some(b => b.type === 'tool_use' && b.name !== 'Agent' && b.name !== 'Task' && !done.has(b.id));
}

// Turn state from the entries, not the mtime: thinking, long replies and long tool calls write nothing for minutes.
// A turn starts at a user entry with `turnPosition` (human prompt, peer message, task notification; queued_command
// attachments only land mid-turn) and ends at `turn_duration`, an API error, or an Esc interrupt. An interrupt
// parented on the newest start is the marker of a prompt that interrupted the previous turn, so that turn goes on.
// Assistant output after an end (a turn retried after /login) reopens it.
// Whether the Claude Code process of a CLI session is gone (closed or killed), by the session ids live processes hold
// (liveSessions). Never for a transcript written in the last WORKING_MS, or without a registry to ask.
// ponytail: only entrypoint "cli" sessions are judged; whether `claude -p`/SDK sessions register is unknown
export function closedSession(entries, ageMs, live) {

    const e = live && ageMs > WORKING_MS ? entries.findLast(e => e.sessionId && e.entrypoint) : null;

    return e?.entrypoint === 'cli' && !live.has(e.sessionId);
}

// live: see closedSession; a closed session's open turn is over.
// Returns { state: 'working' | 'asking' | 'stuck' | 'idle', since: turn start ms | null, died?: true }.
// died: with 'stuck', a turn that never ended and has been silent for TURN_STALE_MS. Never for a closed session: a
// process the user ended on purpose can't be told from one that vanished.
export function turnState(entries, ageMs, marker = null, live = null) {

    if (closedSession(entries, ageMs, live)) {
        return { state: 'idle', since: null };
    }
    if (pendingAsk(entries, marker)) {
        return { state: 'asking', since: null };
    }

    let start = null;
    let open = false;
    let known = false; // this Claude Code writes turn markers
    for (const e of entries) {
        // the summary after a compact_boundary carries turnPosition but starts no turn: idle compaction never ends it
        if (e.isSidechain || e.isCompactSummary) {
            continue;
        }
        if (e.type === 'system' && e.subtype === 'turn_duration') {
            known = true;
            open = false;
        } else if (e.type === 'user' && e.turnPosition) {
            known = true;
            start = e;
            open = true;
        } else if (e.type === 'attachment' && e.attachment?.type === 'queued_command') {
            start = open ? start : e;
            open = true;
        } else if (e.type === 'assistant' && e.isApiErrorMessage) {
            open = false;
        } else if (e.type === 'assistant') {
            if (!open) {
                start = e;
            }
            open = true;
        } else if (e.type === 'user' && INTERRUPTED.test(textOf(e).trim()) && e.parentUuid !== start?.uuid) {
            open = false;
        }
    }

    // ponytail: a tail with no turn markers at all (older Claude Code, or one turn longer than the tail) falls back to the mtime
    // a long tool call writes nothing, so a live process the registry calls busy is working however old the transcript
    const busy = !!live?.busy?.has(entries.findLast(e => e.sessionId)?.sessionId);
    if (known && open && ageMs >= TURN_STALE_MS && !busy) {
        return { state: 'stuck', since: null, died: true }; // idle for everything but the chat status, which says Claude may be stuck
    }
    const working = known ? open && (ageMs < TURN_STALE_MS || busy) : ageMs < WORKING_MS;

    return { state: working ? 'working' : 'idle', since: working && known ? Date.parse(start?.timestamp) || null : null };
}

// False when a transcript with real turns has none of the markers turnState reads: Claude Code's format changed.
export const hasTurnMarkers = entries => !entries.some(e => !e.isSidechain && e.type === 'assistant')
    || entries.some(e => (e.type === 'system' && e.subtype === 'turn_duration') || (e.type === 'user' && e.turnPosition));

// The human prompts of the open turn (the one that started it, typed or queued, and any queued into it), as [{ at, text }].
export function turnPrompts(entries, ageMs, marker = null, live = null) {

    if (turnState(entries, ageMs, marker, live).state !== 'working') {
        return [];
    }

    let prompts = [];
    for (const e of entries) {
        if (e.isSidechain || e.isCompactSummary) {
            continue;
        }
        const a = e.type === 'attachment' ? e.attachment : null;
        if (e.type === 'system' && e.subtype === 'turn_duration') {
            prompts = [];
        } else if (e.type === 'user' && e.turnPosition) {
            prompts = isHumanPrompt(e) ? [{ at: e.timestamp, text: unwrapPasted(textOf(e)) }] : [];
        } else if (a?.type === 'queued_command' && a.origin?.kind === 'human') {
            prompts.push({ at: e.timestamp, text: unwrapPasted(textOf({ message: { content: a.prompt } })) });
        }
    }

    return prompts;
}

const spawnCache = new WeakMap(); // parsed tail (one per transcript mtime) -> its spawnPrompts
const NOTE = /<task-id>(\w+)<\/task-id>(?:\s*<tool-use-id>(\w+)<\/tool-use-id>)?/;

// The human prompts behind each Agent call in the tail, as tool_use id -> text: those of the turn that made the call
// (the one that started it plus any queued into it before the call). A turn a task notification started inherits them
// from the agent it reports on, so the agents a gate's verdict leads to link like the gate.
export function spawnPrompts(entries) {

    if (spawnCache.has(entries)) {
        return spawnCache.get(entries);
    }

    const byUse = new Map(), useOf = new Map(); // tool_use id -> prompts; agent id -> its tool_use id
    let prompts = [];
    for (const e of entries) {
        if (e.isSidechain || e.isCompactSummary) {
            continue;
        }
        const a = e.type === 'attachment' ? e.attachment : null;
        const blocks = Array.isArray(e.message?.content) ? e.message.content : [];
        if (e.type === 'user' && e.turnPosition) {
            const note = textOf(e).match(NOTE);
            prompts = isHumanPrompt(e) ? [unwrapPasted(textOf(e))] : byUse.get(note?.[2] ?? useOf.get(note?.[1])) ?? [];
        } else if (a?.type === 'queued_command' && a.origin?.kind === 'human') {
            prompts = [...prompts, unwrapPasted(textOf({ message: { content: a.prompt } }))];
        } else if (e.type === 'assistant') {
            blocks.filter(b => b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')).forEach(b => byUse.set(b.id, prompts));
        } else if (e.type === 'user') {
            for (const b of blocks.filter(b => b.type === 'tool_result' && byUse.has(b.tool_use_id))) {
                const id = JSON.stringify(b.content ?? '').match(/agentId: (\w+)/)?.[1];
                if (id) {
                    useOf.set(id, b.tool_use_id);
                }
            }
        }
    }

    const out = new Map([...byUse].filter(([, p]) => p.length).map(([id, p]) => [id, p.join('\n')]));
    spawnCache.set(entries, out);

    return out;
}
