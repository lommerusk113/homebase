// Transcript parsing: tail reading and its cache, chat bubbles, TLDR/topic, turn state, review-gate runs, token usage, GET /api/transcript.
import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(homedir(), '.claude', 'projects');
// ponytail: only the tail is parsed (transcripts reach 70+ MB); subagent token totals use the offset reader below
const TAIL_BYTES = 512 * 1024;
const TAIL_MIN_LINES = 200;
const TAIL_MAX_BYTES = 16 * 1024 * 1024;
export const WORKING_MS = 10_000;
const TURN_STALE_MS = 30 * 60_000; // an open turn with no transcript write this long is treated as dead

export const cache = new Map(); // path -> { mtimeMs, entries }

// A few huge lines (tool results, api-request blobs of ~1 MB) can fill the byte tail on their own, so it grows
// until it holds TAIL_MIN_LINES lines, the whole file or `cap` bytes.
export async function readTail(path, size, max = TAIL_BYTES, cap = TAIL_MAX_BYTES) {

    const fh = await open(path, 'r');
    try {
        let len = Math.min(size, max), lines;
        for (;;) {
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, size - len);
            lines = buf.toString('utf8').split('\n');
            if (len < size) {
                lines.shift(); // partial first line
            }
            if (lines.length >= TAIL_MIN_LINES || len >= size || len >= cap) {
                break;
            }
            len = Math.min(size, len * 2);
        }

        return lines.flatMap(l => {
            try {
                return l ? [JSON.parse(l)] : [];
            } catch {
                return [];
            }
        });
    } finally {
        await fh.close();
    }
}

export async function tailOf(path, st) {

    let hit = cache.get(path);
    if (!hit || hit.mtimeMs !== st.mtimeMs) {
        hit = { mtimeMs: st.mtimeMs, entries: await readTail(path, st.size) };
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

export function isHumanPrompt(e) {
    return e.type === 'user' && !e.isMeta && !e.isCompactSummary && !e.isSidechain && textOf(e) && !textOf(e).startsWith('<');
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
const TLDR = /^[ \t>*_]*TL;?DR\b[*_]*:?[*_]*[ \t]*(.+)$/gim;

// "**▸ Topic**" / "**▸ Topic:**" / "▸ Topic" as the first non-empty line becomes the bubble's header.
// A "· needs you" / "- needs you" / "(needs you)" suffix marks a reply that wants the user's decision, answer or action.
const TOPIC = /^\s*(?:\*\*)?▸\s*(.+?):?\s*(?:\*\*)?[ \t]*(?:\n|$)/;
const NEEDS_YOU = /\s*(?:[·\-–—]\s*needs you|\(needs you\))\s*$/i;
export function splitTopic(text) {

    const m = text.match(TOPIC);
    if (!m) {
        return { topic: null, needsYou: false, text };
    }

    const raw = m[1].replace(/\*\*$/, '').replace(/:$/, '').trim(), needsYou = NEEDS_YOU.test(raw);

    return { topic: raw.replace(NEEDS_YOU, '').trim() || null, needsYou, text: text.slice(m[0].length).trim() };
}

// What the session is on now: the topic of Claude's newest reply that has one, from the parsed tail.
export function latestTopic(entries) {

    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.type === 'assistant' && !e.isSidechain) {
            const text = textOf(e);
            const topic = text && splitTopic(text).topic;
            if (topic) {
                return topic;
            }
        }
    }

    return null;
}

// Human prompts still waiting in Claude Code's queue, replayed from queue-operation entries: enqueue appends, dequeue
// takes the head, remove (absorbed mid-turn, or cancelled) drops the matching text. Task notifications and agent
// messages queue too ("<..." text) and are left out.
// ponytail: a queue older than the tail replays partly; a dequeue then takes the wrong head until the queue drains.
export function queuedPrompts(entries) {

    const queue = [];
    for (const e of entries) {
        if (e.type !== 'queue-operation') {
            continue;
        }
        if (e.operation === 'enqueue') {
            queue.push({ at: e.timestamp, text: typeof e.content === 'string' ? e.content : '' });
        } else if (e.operation === 'dequeue') {
            queue.shift();
        } else if (e.operation === 'remove') {
            const i = queue.findIndex(q => q.text === e.content);
            if (i >= 0) {
                queue.splice(i, 1);
            }
        }
    }

    return queue.filter(q => q.text.trim() && !q.text.trimStart().startsWith('<'));
}

// Pulls the last "TLDR: ..." line out of a message so the page can show it as a callout.
export function splitTldr(text) {

    const m = [...text.matchAll(TLDR)].at(-1);
    if (!m) {
        return { tldr: null, text };
    }

    let tldr = m[1].trim();
    if ((tldr.match(/\*\*/g)?.length ?? 0) % 2) {
        tldr = tldr.replace(/\*\*$/, '').trim(); // "**TLDR: x**" leaves a dangling **
    }

    return { tldr, text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim() };
}

// review-gate's verdict line ("**Verdict: fix first** — ...") or its bold TLDR ("**ready**").
const VERDICT = /(?:verdict:?[*_\s]*|\*\*)(ready|fix[- ]first)\b/i;
const GATE = /review[- ]gate/i;
const COMMIT = /\b(?:commit|head|sha)\b[\s:`@]*([0-9a-f]{7,40})\b/i;

// review-gate runs in a transcript tail: a Skill tool_use for review-gate (or a subagent briefed with it, via `brief`),
// then the first assistant text or handback naming a verdict. text = the skill args or brief plus the report, for gateFor.
export function gateRuns(entries, brief = null) {

    const runs = [];
    let armed = brief && GATE.test(brief) ? brief : null;
    for (const e of entries) {
        if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) {
            continue;
        }
        for (const b of e.message.content) {
            if (b.type === 'tool_use' && b.name === 'Skill' && /(?:^|:)review-gate$/.test(b.input?.skill ?? '')) {
                armed = String(b.input.args ?? '');
                continue;
            }
            const said = b.type === 'text' ? b.text : b.type === 'tool_use' && b.name === 'SubagentHandback' ? b.input?.message : null;
            const v = armed !== null && said?.match(VERDICT);
            if (v) {
                const text = `${armed}\n${said}`;
                runs.push({ verdict: v[1].toLowerCase().replace('-', ' '), at: Date.parse(e.timestamp) || 0, tldr: splitTldr(said).tldr, commit: text.match(COMMIT)?.[1] ?? null, text });
                armed = null;
            }
        }
    }

    return runs;
}

const TOOL_KIND = { Bash: 'cmd', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'search', Glob: 'search', Agent: 'agent', Task: 'agent', WebFetch: 'web', WebSearch: 'web' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const PHRASES = {
    cmd: n => `ran ${plural(n, 'command')}`,
    edit: n => `edited ${plural(n, 'file')}`,
    read: n => `read ${plural(n, 'file')}`,
    search: n => `searched ${plural(n, 'time')}`,
    agent: n => `started ${plural(n, 'agent')}`,
    web: n => plural(n, 'web lookup'),
    other: n => `used ${plural(n, 'other tool')}`
};

// "Ran 3 commands · edited 2 files · started 2 agents"
export function toolSummary(uses) {

    const counts = {};
    const edited = new Set();
    for (const u of uses) {
        const kind = TOOL_KIND[u.name] ?? 'other';
        if (kind === 'edit') {
            edited.add(u.input?.file_path ?? u.input?.notebook_path);
        } else {
            counts[kind] = (counts[kind] ?? 0) + 1;
        }
    }
    counts.edit = edited.size;

    const text = Object.keys(PHRASES).filter(k => counts[k]).map(k => PHRASES[k](counts[k])).join(' · ');

    return text.charAt(0).toUpperCase() + text.slice(1);
}

// Multi-line pastes are stored as `<pasted_content id="x">…</pasted_content id="x">`; show only what was typed.
const PASTED = /<pasted_content id="([^"]*)">\n?([\s\S]*?)\n?<\/pasted_content(?: id="\1")?>/g;
export const unwrapPasted = s => (typeof s === 'string' ? s.replace(PASTED, '$2').trim() : '');
const DUP_MS = 60_000;
const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/;

// Master chat as bubbles: human prompts, Claude's text (consecutive chunks merged), and one activity line per run of tool calls.
export function chatItems(entries, max = 60) {

    const items = dedupePrompts([...mergeChunks(rawItems(entries)), ...pendingPrompts(entries)]);
    const out = pairAnswers(items.map(i => (i.role === 'assistant' ? topicAndTldr(i) : i))).slice(-max);

    const last = out.at(-1);
    if (last?.role === 'assistant' && !last.answer) {
        last.replies = quickReplies(last.tldr, last.text); // only the newest item, so any later user message hides them
    }

    return out;
}

// What a main-chat entry adds to the bubbles, or null for nothing:
// - interrupt: the Esc marker, which flags Claude's message before it;
// - prompt: a typed prompt, or one queued while Claude worked and absorbed into the running turn;
// - turn: any other non-tool-result user entry (agent message, task notification, reminder), which starts a new turn;
// - error: an API error line;
// - assistant: Claude's text and tool calls.
function entryKind(e) {

    if (e.isSidechain) {
        return null;
    }

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
        return { kind: 'compact' };
    }
    if (e.isCompactSummary) {
        return null; // the summary text Claude Code writes after the boundary
    }

    const human = e.type === 'user' && !e.isMeta ? unwrapPasted(textOf(e)) : '';
    if (INTERRUPTED.test(human)) {
        return { kind: 'interrupt' };
    }
    if (human && !human.startsWith('<')) {
        return { kind: 'prompt', text: human };
    }

    const a = e.type === 'attachment' ? e.attachment : null;
    if (a?.type === 'queued_command' && a.origin?.kind === 'human') {
        return { kind: 'prompt', text: unwrapPasted(textOf({ message: { content: a.prompt } })) };
    }
    if (e.type === 'user' && !(Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_result'))) {
        return { kind: 'turn' };
    }
    if (e.type !== 'assistant') {
        return null;
    }
    // "Please run /login · API Error: 403 …": a red error line, not a Claude bubble
    if (e.isApiErrorMessage) {
        return { kind: 'error', text: textOf(e) };
    }

    return { kind: 'assistant', text: textOf(e), uses: Array.isArray(e.message?.content) ? e.message.content.filter(b => b.type === 'tool_use') : [] };
}

// Bubbles in entry order: one per Claude text chunk, marked `continues` unless a new turn started before it, and one
// activity line per run of tool calls.
function rawItems(entries) {

    const items = [];
    let uses = [];
    const flush = () => {
        if (uses.length) {
            items.push({ role: 'tools', text: toolSummary(uses) });
            uses = [];
        }
    };

    let newTurn = false;
    for (const e of entries) {
        const entry = entryKind(e);
        if (entry?.kind === 'interrupt') {
            const prev = items.findLast(i => i.role === 'assistant');
            if (prev) {
                prev.interrupted = true;
            }
        } else if (entry?.kind === 'prompt') {
            flush();
            items.push({ role: 'user', text: entry.text, at: e.timestamp });
        } else if (entry?.kind === 'compact') {
            flush();
            items.push({ role: 'compact', text: 'Conversation compacted', at: e.timestamp });
            newTurn = true;
        } else if (entry?.kind === 'turn') {
            newTurn = true;
        } else if (entry?.kind === 'error') {
            flush();
            items.push({ role: 'error', text: entry.text, at: e.timestamp });
            newTurn = true;
        } else if (entry?.kind === 'assistant') {
            if (entry.text) {
                flush();
                items.push({ role: 'assistant', text: entry.text, at: e.timestamp, ...(!newTurn && { continues: true }) });
                newTurn = false;
            }
            uses.push(...entry.uses);
        }
    }
    flush();

    return items;
}

// Joins a `continues` chunk into the Claude bubble right before it, so two replies of separate turns stay separate.
function mergeChunks(items) {

    const out = [];
    for (const { continues, ...item } of items) {
        const prev = out.at(-1);
        if (continues && prev?.role === 'assistant') {
            prev.text += '\n\n' + item.text;
            if (item.interrupted) {
                prev.interrupted = true;
            }
            continue;
        }
        out.push(item);
    }

    return out;
}

// Messages typed while Claude works are queued first, then absorbed into the running turn as an attachment; the ones
// still queued are pending bubbles.
// ponytail: replays the queue in the tail; a dequeue whose enqueue fell out of the tail shifts the wrong item
function pendingPrompts(entries) {

    const queue = [];
    for (const e of entries) {
        if (e.isSidechain || e.type !== 'queue-operation') {
            continue;
        }
        if (e.operation === 'enqueue') {
            queue.push({ raw: e.content, text: unwrapPasted(e.content), at: e.timestamp });
        } else if (e.operation === 'dequeue') {
            queue.shift();
        } else if (e.operation === 'remove') {
            const i = queue.findIndex(q => q.raw === e.content);
            if (i >= 0) {
                queue.splice(i, 1);
            }
        }
    }

    return queue
        .filter(q => q.text && !q.text.startsWith('<'))
        .map(q => ({ role: 'user', text: q.text, at: q.at, pending: true }));
}

// One message can surface as a prompt, a queued_command attachment and a pending enqueue; keep the first.
function dedupePrompts(items) {

    const seen = [];

    return items.filter(i => {
        if (i.role !== 'user') {
            return true;
        }
        const norm = i.text.replace(/\s+/g, ' '), t = Date.parse(i.at);
        if (seen.some(u => u.norm === norm && Math.abs(u.t - t) < DUP_MS)) {
            return false;
        }
        seen.push({ norm, t });

        return true;
    });
}

function topicAndTldr(i) {

    const { topic, needsYou, text } = splitTopic(i.text), t = splitTldr(text);

    // no marker: a TLDR that ends in a question still needs the user
    return { ...i, topic, needsYou: needsYou || /\?[*_\s]*$/.test(t.tldr ?? ''), ...t };
}

const SHORT_ANSWER = /^(?:yes|yeah|yep|sure|ok|okay|no|nope|do it|go ahead|do both)(?: please)?[.!]*$/i;

// A short reply right after a Claude message that asked something becomes its answer tag instead of a bubble:
// a chip label offered on it, or a tiny approval like "ok" / "go ahead". Only the item directly before counts.
function pairAnswers(items) {

    const out = [];
    for (const i of items) {
        const prev = out.at(-1);
        const text = i.role === 'user' ? i.text.trim() : '';
        const asked = prev?.role === 'assistant' && !prev.answer && quickReplies(prev.tldr, prev.text);
        if (asked?.length && (asked.includes(text) || SHORT_ANSWER.test(text))) {
            out[out.length - 1] = { ...prev, answer: { text, at: i.at, ...(i.pending && { queued: true }) } };
            continue;
        }
        out.push(i);
    }

    return out;
}

const NOT_AN_OPTION = /\bor (?:not|no|so|something|anything|otherwise|later)\b/i;

// Reply chips for a Claude message that ends by asking the user something: its TLDR or its last paragraph ends in "?".
// Only the ending counts, so rhetorical or quoted questions earlier in the body don't; quotes, code and lists of questions are skipped.
export function quickReplies(tldr, text) {

    const lastParagraph = (text ?? '').trim().split(/\n\s*\n/).at(-1) ?? '';
    const ask = [tldr ?? '', lastParagraph]
        .map(s => s.trim().replace(/[*_\s]+$/, ''))
        .find(s => s.endsWith('?') && !/^(>|```|\|)/.test(s) && s.split('\n').filter(l => /\?[*_\s]*$/.test(l)).length === 1);
    if (!ask) {
        return [];
    }

    const question = ask.match(/[^.!?\n]*\?$/)[0];
    const twoOptions = /\bor\b/i.test(question) && !NOT_AN_OPTION.test(question);

    return twoOptions ? ['Yes', 'Do both', 'No'] : ['Yes', 'No'];
}

// The questions of an AskUserQuestion that has no tool_result yet, as [{ question, options: [label] }], else null.
export function pendingAsk(entries) {

    const ask = entries
        .filter(e => e.type === 'assistant' && !e.isSidechain && Array.isArray(e.message?.content))
        .flatMap(e => e.message.content)
        .findLast(b => b.type === 'tool_use' && b.name === 'AskUserQuestion');
    if (!ask) {
        return null;
    }

    const answered = entries.some(e => e.type === 'user' && Array.isArray(e.message?.content)
        && e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === ask.id));

    return answered ? null : (ask.input?.questions ?? []).map(q => ({ question: q.question ?? '', options: (q.options ?? []).map(o => o.label).filter(Boolean) }));
}

// The question text of a pending AskUserQuestion, else null.
export function pendingQuestion(entries) {

    const questions = pendingAsk(entries);

    return questions && (questions[0]?.question || 'Claude asked a question.');
}

// Turn state from the entries, not the mtime: thinking, long replies and long tool calls write nothing for minutes.
// A turn starts at a user entry with `turnPosition` (human prompt, peer message, task notification; queued_command
// attachments only land mid-turn) and ends at `turn_duration`, an API error, or an Esc interrupt. An interrupt
// parented on the newest start is the marker of a prompt that interrupted the previous turn, so that turn goes on.
// Assistant output after an end (a turn retried after /login) reopens it.
// Returns { state: 'working' | 'asking' | 'idle', since: turn start ms | null }.
export function turnState(entries, ageMs) {

    if (pendingAsk(entries)) {
        return { state: 'asking', since: null };
    }

    let start = null;
    let open = false;
    let known = false; // this Claude Code writes turn markers
    for (const e of entries) {
        if (e.isSidechain) {
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
    const working = known ? open && ageMs < TURN_STALE_MS : ageMs < WORKING_MS;

    return { state: working ? 'working' : 'idle', since: working && known ? Date.parse(start?.timestamp) || null : null };
}

// The human prompts of the open turn (the one that started it, typed or queued, and any queued into it), as [{ at, text }].
export function turnPrompts(entries, ageMs) {

    if (turnState(entries, ageMs).state !== 'working') {
        return [];
    }

    let prompts = [];
    for (const e of entries) {
        if (e.isSidechain) {
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
        if (e.isSidechain) {
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

const usageCache = new Map(); // subagent transcript path -> { offset, byId, first, last, totals }
export const USAGE_KEYS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' };

// Folds complete JSONL lines into u. Streamed chunks repeat a message id with the same usage, so the last one per id wins.
export function addUsage(u, text) {

    for (const line of text.split('\n')) {
        let e;
        try {
            e = JSON.parse(line);
        } catch {
            continue;
        }
        const t = Date.parse(e.timestamp);
        if (t) {
            u.first = Math.min(u.first ?? t, t);
            u.last = Math.max(u.last ?? t, t);
        }
        if (e.type === 'assistant' && e.message?.usage) {
            u.byId.set(e.message.id ?? Symbol(), e.message.usage);
        }
    }

    u.totals = Object.fromEntries(Object.entries(USAGE_KEYS).map(([k, f]) => [k, [...u.byId.values()].reduce((n, x) => n + (x[f] ?? 0), 0)]));

    return u;
}

// Token totals and first/last timestamp of a transcript, reading only the bytes appended since the last call.
export async function readUsage(path, size) {

    size ??= (await stat(path)).size;
    let u = usageCache.get(path);
    if (!u || size < u.offset) {
        u = { offset: 0, byId: new Map(), first: null, last: null, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        usageCache.set(path, u);
    }

    if (size > u.offset) {
        const fh = await open(path, 'r');
        try {
            const buf = Buffer.alloc(size - u.offset);
            const { bytesRead } = await fh.read(buf, 0, buf.length, u.offset);
            // ponytail: a partial trailing line isn't buffered; the offset stops before it and the line is re-read once complete
            const end = buf.lastIndexOf(10, bytesRead - 1) + 1;
            if (end) {
                addUsage(u, buf.toString('utf8', 0, end));
                u.offset += end;
            }
        } finally {
            await fh.close();
        }
    }

    return { ...u.totals, first: u.first, last: u.last };
}

// "14m", "1h 05m"
export function formatDuration(ms) {

    const m = Math.round(ms / 60_000);

    return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// "1.2M tok"
export function formatTokens(n) {

    const [d, unit] = n >= 1e6 ? [1e6, 'M'] : n >= 1e3 ? [1e3, 'k'] : [1, ''];

    return `${+(n / d).toFixed(n >= 10 * d || d === 1 ? 0 : 1)}${unit} tok`;
}

export async function transcript(dir, id) {

    const path = join(ROOT, dir, `${id}.jsonl`);
    if (!path.startsWith(ROOT + '/') || dir.includes('/') || id.includes('/')) {
        throw new Error('bad path');
    }

    const st = await stat(path);
    const entries = await tailOf(path, st);

    const turn = turnState(entries, Date.now() - st.mtimeMs);

    return { items: chatItems(entries), asking: pendingQuestion(entries), questions: pendingAsk(entries), working: turn.state === 'working', since: turn.since };
}
