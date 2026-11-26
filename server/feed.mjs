// The chat feed: transcript entries turned into bubbles (prompts, replies, tool lines, commands, agent results), answers
// paired with their questions, and feedTail for "Show earlier".
import { cache, tailOf, readTailInfo, TAIL_MAX_BYTES, textOf, isSystemText, unwrapPasted, INTERRUPTED } from './entries.mjs';
import { isHousekeeping } from './sendlog.mjs';
import { RISKY, TOOL_KIND, toolSummary, queuedPrompts } from './summaries.mjs';
import { topicAndTldr, replyChips } from './asks.mjs';
import { cannedLabel } from '../web/src/lib/canned.ts';

export const FEED_ITEMS = 60; // chat items per load; the page's "Show earlier" asks for more

// The chat feed of a transcript: the cached tail's, or, when "Show earlier" asks for more items (max) than that tail
// holds, a tail read further back. more: older messages exist that are not in items and can be asked for. capped: older
// ones exist but lie before the last `cap` bytes, which is as far back as this reads.
// ponytail: one deeper tail is kept (the chat being scrolled back), re-read at its size on each transcript write and
// never past TAIL_MAX_BYTES; page by byte offset if scrolling far back in a 20+ MB transcript gets slow
let deep = null; // { path, mtimeMs, entries, bytes, cut }
export async function feedTail(path, st, max = FEED_ITEMS, cap = TAIL_MAX_BYTES) {

    const entries = await tailOf(path, st);
    let tail = cache.get(path), feed = chatFeed(entries, max);
    const short = () => max > FEED_ITEMS && !feed.earlier && tail.cut && tail.bytes < cap;
    if (short()) {
        const kept = deep?.path === path ? deep : null;
        tail = kept?.mtimeMs === st.mtimeMs ? kept : await readTailInfo(path, st.size, kept?.bytes ?? tail.bytes * 2);
        for (;;) {
            feed = chatFeed(tail.entries, max);
            if (!short()) {
                break;
            }
            tail = await readTailInfo(path, st.size, Math.min(tail.bytes * 2, cap), cap);
        }
        deep = { path, mtimeMs: st.mtimeMs, entries: tail.entries, bytes: tail.bytes, cut: tail.cut };
    }
    const more = feed.earlier > 0 || (tail.cut && tail.bytes < cap);

    return { ...feed, entries, more, capped: !more && tail.cut };
}

const DUP_MS = 60_000;

// Ids of the replies the user marked as handled: they no longer need you (server/handled.mjs keeps them on disk).
export const handled = new Set();

// Master chat as bubbles: human prompts, Claude's text (consecutive chunks merged), and one activity line per run of tool calls.
export const chatItems = (entries, max = 60) => chatFeed(entries, max).items;

// The newest `max` items, plus any older question still waiting on you; earlier: how many older items were left out.
export function chatFeed(entries, max = 60) {

    // Homebase's own notes ("Load new rules"), as its send log flags them: no answer to anything
    const sid = entries.find(e => e.sessionId)?.sessionId;
    const items = dedupePrompts([...mergeChunks(rawItems(entries)), ...pendingPrompts(entries)])
        .map(i => (i.role === 'user' && isHousekeeping(sid, i.text) ? { ...i, housekeeping: true } : i));
    const all = pairAnswers(items.map(i => (i.role === 'assistant' ? topicAndTldr(i) : i)));

    // a question the user has answered or replied after no longer needs them
    let replied = false;
    for (const i of all.toReversed()) {
        replied ||= i.role === 'user' && !i.housekeeping;
        if (i.needsYou && (replied || i.answer)) {
            i.needsYou = false;
        }
        if (handled.has(i.id)) { // marked as handled: no pill, no pinned decision
            i.needsYou = false;
            delete i.waiting;
            delete i.ask;
        }
        replied ||= !!i.answer; // an answer given in the ask card also settles what was asked before it
    }
    // the newest reply's open decision stays pinned too, however far back it is
    const pinned = all.findLast(i => i.role === 'assistant');
    const out = all.filter((i, n) => n >= all.length - max || i.needsYou || (i === pinned && i.waiting && !i.answer));

    // chips stay on every question still waiting, also after Claude said more; a later user message clears needsYou,
    // a later Waiting on you replaces an older one's
    const lastWait = out.findLast(i => i.role === 'assistant' && i.waiting);
    for (const i of out) {
        if (i.role === 'assistant' && i.needsYou && !i.answer && !(i.waiting && i !== lastWait)) {
            i.replies = replyChips(i);
        }
    }

    const last = out.at(-1);
    if (last?.role === 'assistant' && !last.answer) {
        last.replies = replyChips(last);
    }

    // the newest reply's open decision stays pinned (the page's strip) after the user says something else: give it its chips
    const open = out.findLast(i => i.role === 'assistant');
    if (open?.waiting && !open.answer) {
        open.replies ??= replyChips(open);
    }

    return { items: out, earlier: all.length - out.length };
}

// What a main-chat entry adds to the bubbles, or null for nothing:
// - interrupt: the Esc marker, which flags Claude's message before it;
// - prompt: a typed prompt, or one queued while Claude worked and absorbed into the running turn;
// - turn: any other non-tool-result user entry (agent message, task notification, reminder), which starts a new turn;
// - agent: a subagent's task notification absorbed mid-turn, which does not start a new turn;
// - error: an API error line;
// - assistant: Claude's text and tool calls.
// A subagent's task notification as a chat line ({ text: "Agent finished: Fix login", failed }), else null. Background
// commands, and an agent that only waits on its own background work, stay out; failed and stopped agents are error lines.
const AGENT_DONE = /^\s*<task-notification>[\s\S]*?<status>(\w+)<\/status>\s*<summary>(?:Background )?[Aa]gent "([^"]+)"(?! is waiting on its own background work)/;
function agentDone(text) {

    const m = text.match(AGENT_DONE);
    if (!m) {
        return null;
    }

    const done = m[1] === 'completed';
    const detail = text.match(/<result>([\s\S]*)<\/result>/)?.[1].trim(); // what the agent handed back, folded under its line

    return { text: `Agent ${done ? 'finished' : m[1] === 'failed' ? 'failed' : 'stopped'}: ${m[2]}`, failed: !done, ...(detail && { detail: clip(detail) }) };
}

// ponytail: command output and agent results are cut at OUTPUT_MAX chars, so one huge dump can't bloat every poll
const OUTPUT_MAX = 8000;
const clip = t => (t.length > OUTPUT_MAX ? `${t.slice(0, OUTPUT_MAX)}\n…` : t);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const tagged = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];

// A slash command or `!` bash line run in the chat or the terminal, as Claude Code logs it (a user line, or a
// system/local_command line in newer versions): { kind: 'local', cmd } for the command, { kind: 'local', out } for its output.
function localCommand(e) {

    const t = e.type === 'system' && e.subtype === 'local_command' ? String(e.content ?? '') : e.type === 'user' ? textOf(e) : '';
    if (!/^\s*<(?:command-name|bash-input|local-command-stdout|bash-stdout)>/.test(t)) {
        return null;
    }

    const bash = tagged(t, 'bash-input'), name = tagged(t, 'command-name');
    const cmd = name ? `${name} ${tagged(t, 'command-args') ?? ''}`.trim() : bash === undefined ? undefined : `! ${bash.trim()}`;
    const out = ['local-command-stdout', 'bash-stdout', 'bash-stderr'].map(n => tagged(t, n)?.replace(ANSI, '').trim()).filter(Boolean).join('\n');

    return { kind: 'local', cmd, out: clip(out) };
}

// "The coordinator sent a message while you were working:\n<text>\n\nAddress this before completing your current task." (the only wording in 137 transcripts)
const COORDINATOR_WRAP = /^The coordinator sent a message while you were working:\n([\s\S]*?)(?:\n\nAddress this before completing your current task\.)?$/;
// The framing Homebase's Step in adds around what the user typed (useComposer.ts): the helper's view shows only the typed text
const STEP_IN_WRAP = /^\[The user stepped into your chat and is talking to you directly\.\] ([\s\S]*?)(?: — Answer them as you would in a normal chat:[\s\S]*)?$/;
export const unwrapRelay = s => s.replace(COORDINATOR_WRAP, '$1').trim().replace(STEP_IN_WRAP, '$1').trim();

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

    const local = localCommand(e);
    if (local) {
        return local;
    }

    // a message the coordinator sent a helper mid-work (the main chat's SendMessage): the user's own words, minus Claude Code's wrapper
    if (e.type === 'user' && e.origin?.kind === 'coordinator' && typeof e.message?.content === 'string') {
        return { kind: 'prompt', text: unwrapRelay(e.message.content), src: 'typed' };
    }

    const human = e.type === 'user' && !e.isMeta ? unwrapPasted(textOf(e)) : '';
    if (INTERRUPTED.test(human)) {
        return { kind: 'interrupt' };
    }
    if (human && !isSystemText(human)) {
        return { kind: 'prompt', text: human, src: 'typed' };
    }

    const a = e.type === 'attachment' ? e.attachment : null;
    if (a?.type === 'queued_command' && a.origin?.kind === 'human') {
        return { kind: 'prompt', text: unwrapRelay(unwrapPasted(textOf({ message: { content: a.prompt } }))), src: 'queued' };
    }
    // a notification absorbed mid-turn: its line, but the turn goes on
    if (a?.type === 'queued_command' && a.origin?.kind === 'task-notification') {
        const agent = agentDone(textOf({ message: { content: a.prompt } }));
        return agent && { kind: 'agent', agent };
    }
    if (e.type === 'user' && !(Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_result'))) {
        return { kind: 'turn', agent: agentDone(textOf(e)) };
    }
    if (e.type !== 'assistant') {
        return null;
    }
    // "Please run /login · API Error: 403 …": a red error line, not a Claude bubble
    if (e.isApiErrorMessage) {
        return { kind: 'error', text: textOf(e) };
    }

    // a helper's report to its caller is its reply: SubagentHandback's message, not a tool line
    const calls = Array.isArray(e.message?.content) ? e.message.content.filter(b => b.type === 'tool_use') : [];
    const report = calls.filter(b => b.name === 'SubagentHandback' && typeof b.input?.message === 'string').map(b => b.input.message);

    return { kind: 'assistant', text: [textOf(e), ...report].filter(Boolean).join('\n\n'), uses: calls.filter(b => b.name !== 'SubagentHandback') };
}

// Bubbles in entry order: one per Claude text chunk, marked `continues` unless a new turn started before it, and one
// activity line per run of tool calls.
function rawItems(entries) {

    const items = [];
    let uses = [];
    const lines = new Map(); // tool_use id -> the activity line it is on, once that line exists
    const failed = new Set(); // ids whose result is an error (failed test run, exit 1, rejected edit, hook block), not on a line yet
    // "Ran 3 commands · 1 failed", never hidden as quiet
    const fail = line => {
        line.failed = (line.failed ?? 0) + 1;
        line.quiet = false;
        line.text = `${line.text.replace(/ · \d+ failed$/, '')} · ${line.failed} failed`;
    };
    const flush = () => {
        if (uses.length) {
            // quiet: only commands, reads, searches and the like; the page hides those lines as noise
            const line = { role: 'tools', text: toolSummary(uses), quiet: !uses.some(u => ['edit', 'agent'].includes(TOOL_KIND[u.name])) };
            items.push(line);
            for (const u of uses) {
                lines.set(u.id, line);
                if (failed.delete(u.id)) {
                    fail(line);
                }
            }
            uses = [];
        }
    };

    let newTurn = false;
    let worked = false; // tool calls since your last prompt
    let ran; // the last slash command or bash line, whose output follows as its own entry
    const asks = new Map(); // AskUserQuestion tool_use id -> { text: its questions, at }
    for (const e of entries) {
        const entry = entryKind(e);
        const reply = !e.isSidechain && e.type === 'user' && Array.isArray(e.message?.content)
            && e.message.content.find(b => b.type === 'tool_result' && asks.has(b.tool_use_id));
        if (reply) {
            flush();
            answerAsk(items, e, reply, asks.get(reply.tool_use_id), !newTurn);
            newTurn = true; // what Claude says after the answer is its own bubble
        }
        for (const b of !e.isSidechain && e.type === 'user' && Array.isArray(e.message?.content) ? e.message.content : []) {
            if (b.type === 'tool_result' && b.is_error && b !== reply) {
                const line = lines.get(b.tool_use_id);
                line ? fail(line) : failed.add(b.tool_use_id);
            }
        }
    if (entry?.kind === 'interrupt') {
            // a turn that ran tools but wrote nothing yet gets its own line: the reply before your prompt was not cut
            const prev = items.findLastIndex(i => i.role === 'assistant');
            if (worked && prev <= items.findLastIndex(i => i.role === 'user')) {
                flush();
                items.push({ role: 'tools', text: 'Interrupted', interrupted: true, at: e.timestamp });
            } else if (prev >= 0) {
                items[prev].interrupted = true;
            }
        } else if (entry?.kind === 'prompt') {
            flush();
            worked = false;
            items.push({ role: 'user', text: entry.text, at: e.timestamp, src: entry.src });
        } else if (entry?.kind === 'local') {
            ran = entry.cmd ?? ran;
            // a /compact that went through is the "Conversation compacted" divider: its echo would say it twice
            if (entry.out && !(/^\/compact\b/.test(ran ?? '') && /^Compacted\b/.test(entry.out))) {
                flush();
                items.push({ role: 'command', cmd: ran ?? '', text: entry.out, at: e.timestamp });
            }
            newTurn = true;
        } else if (entry?.kind === 'compact') {
            flush();
            items.push({ role: 'compact', text: 'Conversation compacted', at: e.timestamp });
            newTurn = true;
        } else if (entry?.kind === 'turn' || entry?.kind === 'agent') {
            // an agent notifies again each time it stops: once per prompt of yours is the news
            const a = entry.agent;
            if (a && !items.slice(items.findLastIndex(i => i.role === 'user') + 1).some(i => i.text === a.text)) {
                flush();
                items.push({ role: a.failed ? 'error' : 'tools', text: a.text, at: e.timestamp, notice: true, ...(a.detail && { detail: a.detail }) }); // notice: never answers or ends a question (summarize)
            }
            newTurn ||= entry.kind === 'turn';
        } else if (entry?.kind === 'error') {
            flush();
            items.push({ role: 'error', text: entry.text, at: e.timestamp });
            newTurn = true;
        } else if (entry?.kind === 'assistant') {
            if (entry.text) {
                flush();
                items.push({ role: 'assistant', ...(e.uuid && { id: e.uuid }), text: entry.text, at: e.timestamp, ...(!newTurn && { continues: true }) });
                newTurn = false;
            }
            worked ||= entry.uses.length > 0;
            for (const u of entry.uses) {
                const cmd = u.name === 'Bash' ? String(u.input?.command ?? '').replace(/\s+/g, ' ').trim() : '';
                if (u.name === 'AskUserQuestion') {
                    // shown with its answer (answerAsk); until then it is the ask card's
                    const qs = Array.isArray(u.input?.questions) ? u.input.questions : [];
                    asks.set(u.id, { text: qs.map(q => q?.question).filter(Boolean).join('\n\n'), at: e.timestamp });
                } else if (u.name === 'ExitPlanMode' && typeof u.input?.plan === 'string' && u.input.plan.trim()) {
                    // the plan you are asked to approve, as part of Claude's reply
                    flush();
                    items.push({ role: 'assistant', ...(e.uuid && { id: e.uuid }), text: u.input.plan, at: e.timestamp, ...(!newTurn && { continues: true }) });
                    newTurn = false;
                } else if (RISKY.test(cmd)) {
                    // a push, merge or force on its own visible line, never folded into the hidden "Ran N commands"
                    flush();
                    items.push({ role: 'tools', text: `Ran: ${clip(cmd)}`, risky: true, at: e.timestamp });
                    lines.set(u.id, items.at(-1));
                } else {
                    uses.push(u);
                }
            }
        }
    }
    flush();

    return items;
}

// An AskUserQuestion answered in the card or terminal is a reply like a typed one: its questions join the Claude
// message that asked (adjacent: the bubble right before, same turn), else get a bubble of their own, with the answer
// as that bubble's tag, so it stops needing you and offers no chips.
function answerAsk(items, e, result, ask, adjacent) {

    const picked = Object.values(e.toolUseResult?.answers ?? {}).join(' · ');
    const answer = { text: result.is_error ? 'No answer' : picked || 'Answered', at: e.timestamp };
    const prev = adjacent ? items.at(-1) : null;
    if (prev?.role === 'assistant' && !prev.answer) {
        if (!prev.text.includes(ask.text)) {
            prev.text += `\n\n${ask.text}`;
        }
        prev.answer = answer;
    } else if (ask.text) {
        items.push({ role: 'assistant', text: ask.text, at: ask.at ?? e.timestamp, answer });
    }
}

// Joins a `continues` chunk into the Claude bubble right before it, so two replies of separate turns stay separate.
function mergeChunks(items) {

    const out = [];
    for (const { continues, ...item } of items) {
        const prev = out.at(-1);
        if (continues && prev?.role === 'assistant') {
            prev.text += '\n\n' + item.text;
            if (item.id) {
                prev.id = item.id; // the bubble's newest entry: more text makes it a new reply to mark as handled
            }
            if (item.interrupted) {
                prev.interrupted = true;
            }
            prev.answer ??= item.answer;
            continue;
        }
        out.push(item);
    }

    return out;
}

// Messages typed while Claude works are queued first, then absorbed into the running turn as an attachment; the ones
// still queued are pending bubbles.
function pendingPrompts(entries) {
    return queuedPrompts(entries).map(q => ({ role: 'user', text: q.text, at: q.at, pending: true, src: 'pending' }));
}

// One message can surface as a prompt, a queued_command attachment and a pending enqueue; keep the first. Each shown
// prompt absorbs at most one copy of each other source, so the same text sent twice shows twice.
function dedupePrompts(items) {

    const seen = [];

    return items.filter(i => {
        if (i.role !== 'user') {
            return true;
        }
        const norm = i.text.replace(/\s+/g, ' '), t = Date.parse(i.at);
        const twin = seen.find(u => u.norm === norm && Math.abs(u.t - t) < DUP_MS && !u.srcs.has(i.src));
        if (twin) {
            twin.srcs.add(i.src);
            return false;
        }
        seen.push({ norm, t, srcs: new Set([i.src]) });

        return true;
    }).map(({ src, ...i }) => {
        const label = i.role === 'user' && cannedLabel(i.text); // a button's message: the feed shows this line, the text behind it

        return label ? { ...i, label } : i;
    });
}

const SHORT_ANSWER = /^(?:yes|yeah|yep|sure|ok|okay|no|nope|do it|go ahead|do both)(?: please)?[.!]*$/i;

// A short reply right after a Claude message that asked something becomes its answer tag instead of a bubble:
// a chip label offered on it, or a tiny approval like "ok" / "go ahead". Only the item directly before counts.
// A chip on an older question arrives as: Yes\n\n(Answering your earlier question from <at>: "<excerpt>")
// <at> is the question item's timestamp, the key it is paired on.
const EARLIER = /^([\s\S]*?)\s*\(Answering your earlier question from (\S+): "[^"]*"\)$/;

function pairAnswers(items) {

    const out = [];
    for (let i of items) {
        const earlier = i.role === 'user' ? i.text.trim().match(EARLIER) : null;
        if (earlier) {
            const q = out.findLastIndex(o => o.role === 'assistant' && o.at === earlier[2] && !o.answer);
            if (q >= 0) {
                out[q] = { ...out[q], answer: { text: earlier[1], at: i.at, ...(i.pending && { queued: true }) } };
                continue;
            }
            i = { ...i, text: earlier[1] }; // question gone (cut off): keep just the label
        }
        const prev = out.at(-1);
        const text = i.role === 'user' ? i.text.trim() : '';
        const asked = prev?.role === 'assistant' && !prev.answer && replyChips(prev);
        if (asked?.length && (asked.includes(text) || SHORT_ANSWER.test(text))) {
            out[out.length - 1] = { ...prev, answer: { text, at: i.at, ...(i.pending && { queued: true }) } };
            continue;
        }
        out.push(i);
    }

    return out;
}
