// Reading a reply or tail at a glance: ▸ topic and TLDR, queued prompts, review-gate runs, tool-call summaries and RISKY commands.
import { textOf, isSystemText, unwrapPasted } from './entries.mjs';

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

    const raw = m[1].replace(/\*\*/g, '').replace(/:$/, '').trim(), needsYou = NEEDS_YOU.test(raw);

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

// Human prompts still waiting in Claude Code's queue, as [{ at, text }], replayed from queue-operation entries: enqueue
// appends, dequeue takes the oldest item that isn't a task notification (those wait behind prompts and agent messages,
// and some are never dequeued at all), remove (absorbed mid-turn, or cancelled) drops the matching text. Task
// notifications and agent messages queue too ("<..." text) and are left out.
// ponytail: a queue older than the tail replays partly; a dequeue then takes the wrong item until the queue drains.
export function queuedPrompts(entries) {

    const queue = [];
    for (const e of entries) {
        if (e.isSidechain || e.type !== 'queue-operation') {
            continue;
        }
        if (e.operation === 'enqueue') {
            queue.push({ at: e.timestamp, raw: typeof e.content === 'string' ? e.content : '' });
        } else if (e.operation === 'dequeue') {
            queue.splice(Math.max(0, queue.findIndex(q => !q.raw.trimStart().startsWith('<task-notification>'))), 1);
        } else if (e.operation === 'remove') {
            const i = queue.findIndex(q => q.raw === e.content);
            if (i >= 0) {
                queue.splice(i, 1);
            }
        }
    }

    return queue.map(q => ({ at: q.at, text: unwrapPasted(q.raw) })).filter(q => q.text && !isSystemText(q.text));
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

// review-gate's verdict line ("**Verdict: fix first** — ...", "the verdict is **ready**") or "review-gate is **ready**".
// A bold ready alone ("MR is **ready** for review") said while the gate runs is no verdict.
const VERDICT = /verdict\b[^\n.]{0,30}?\b(ready|fix[- ]first)\b|review[- ]gate\b[^\n.]{0,15}?\*\*(ready|fix[- ]first)\*\*/i;
const GATE = /review[- ]gate/i;
// The MRs a text names, as !N (GitLab refs and merge_requests URLs). ponytail: GitHub #N is skipped, it reads the same as an issue.
const mrRefs = text => new Set([...text.matchAll(/(?<![\w/&])!(\d+)\b|\/merge_requests\/(\d+)\b/g)].map(m => m[1] ?? m[2]));
const COMMIT = /\b(?:commit|head|sha)\b[\s:`@]*([0-9a-f]{7,40})\b/i;

// review-gate runs in a transcript tail: a Skill tool_use for review-gate (or a subagent briefed with it, via `brief`),
// then the first assistant text or handback naming a verdict. text = the skill args or brief plus the report, for gateFor;
// a gate over several MRs gives each MR its own run (see below).
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
            if (!v) {
                continue;
            }
            const at = Date.parse(e.timestamp) || 0;
            const run = (m, part, text) => ({ verdict: (m[1] ?? m[2]).toLowerCase().replace('-', ' '), at, tldr: splitTldr(part).tldr, commit: text.match(COMMIT)?.[1] ?? null, text });
            if (mrRefs(`${armed}\n${said}`).size <= 1) {
                runs.push(run(v, said, `${armed}\n${said}`));
                armed = null;
                continue;
            }
            // a batch over several MRs: one run per paragraph, else per line, that names one MR and a verdict; the arming
            // stays for verdicts reported later. An MR whose verdict shares its text with another MR gets none.
            for (const para of said.split(/\n\s*\n/)) {
                for (const part of mrRefs(para).size === 1 ? [para] : para.split('\n')) {
                    const m = mrRefs(part).size === 1 && part.match(VERDICT);
                    if (m) {
                        runs.push(run(m, part, part));
                    }
                }
            }
        }
    }

    return runs;
}

// Commands that change shared state or are hard to undo: a red permission card (startup.mjs parseQuestion) and their own
// "Ran:" line in the feed (rawItems). The one list for both.
export const RISKY = /\bgit\s+(?:push|merge)(?![\w-])|--force\b|\breset\s+--hard\b|\brm\s+-\w*(?:r\w*f|f\w*r)|\b(?:mr|pr)\s+merge\b|\bdrop\s+table\b|\bkubectl\b/i;
export const TOOL_KIND = { Bash: 'cmd', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'search', Glob: 'search', Agent: 'agent', Task: 'agent', WebFetch: 'web', WebSearch: 'web' };
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
