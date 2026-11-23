// What a reply asks of the user: Waiting on you lines, option lists and their chip labels, yes/no quick replies, and
// topicAndTldr, which splits a reply into topic, TLDR, heads-up, options and its ask.
import { splitTopic, splitTldr } from './summaries.mjs';

export function topicAndTldr(i) {

    const { topic, needsYou, text } = splitTopic(i.text), t = splitTldr(text);
    const heads = t.text.match(HEADS_UP); // shown outside the fold, next to the TLDR
    if (heads) {
        t.text = t.text.replace(heads[0], '').trim();
    }

    // no marker: a TLDR that asks a question ("Merge now? Yes or later.") still needs the user
    const waiting = waitingOn(text), ask = waitingAsk(waiting);
    const needs = needsYou || !!waiting || /\?(?=[\s*_]|$)/.test(t.tldr ?? '');
    const body = withoutInFlight(t.text); // the closing In flight list is status, not choices
    const asks = needs || quickReplies(t.tldr, body).length > 0; // needs you, or ends in a question that gets chips
    const options = asks ? optionsBlock(body) ?? askList(body) : null;

    // asks but no TLDR: its last paragraph (the ask, past the options) is what shows while folded, next to its chips
    if (asks && !t.tldr) {
        const ask = (options ? body.replace(options, '') : body).trim().split(/\n\s*\n/).at(-1);
        if (ask) {
            t.tldr = ask;
            t.text = t.text.replace(ask, '').trim();
        }
    }

    return { ...i, topic, needsYou: needs, ...t, ...(options && { options }), ...(waiting && { waiting }), ...(ask && { ask }), ...(heads && { headsUp: heads[1].trim() }) };
}

// What a reply says waits on the user ("- Waiting on you: <question>" in its In flight list, or a "**Waiting on you:**"
// line), else null; "nothing" / "none" count as nothing.
const WAITING = /^[ \t]*(?:[-*+][ \t]+)?\**Waiting on you\b[*:]*[ \t—–-]*(.*)$/gim;
export function waitingOn(text) {

    let said = [...(text ?? '').matchAll(WAITING)].at(-1)?.[1].trim();
    if ((said?.match(/\*\*/g)?.length ?? 0) % 2) {
        said = said.replace(/\*\*$/, '').trim(); // "**Waiting on you: x**" leaves a dangling **
    }

    return said && !/^(?:nothing|none|n\/a)\b/i.test(said) ? said : null;
}

// A "Waiting on you" line as homebase-rules.md writes it, "<issue> — <what led here> — <question> — (1) <option>; (2) …"
// (also "1. …" or "A) …"), as { question, context, options: [{ label, desc }] } (label: the option up to its first
// ": " or " — ", plus "(recommended)" when it says so), else null when it lists fewer than 2 options.
// ponytail: options split on their markers only; a marker-like "(2)" inside an option's own text cuts it short.
const OPTION_MARKERS = [/\((\d)\)\s+/g, /(?<=^|\s)(\d)[.)]\s+/g, /(?<=^|\s)\(?([A-Da-d])\)\s+/g];
export function waitingAsk(text) {

    for (const re of OPTION_MARKERS) {
        const all = [...(text ?? '').matchAll(re)], at = all.findIndex(m => /^[1Aa]$/.test(m[1]));
        const marks = [];
        for (const m of all.slice(Math.max(at, 0))) {
            if (at >= 0 && parseInt(m[1], 36) === parseInt(all[at][1], 36) + marks.length) {
                marks.push(m);
            }
        }
        if (marks.length < 2) {
            continue;
        }

        const options = marks.map((m, k) => {
            const s = text.slice(m.index + m[0].length, marks[k + 1]?.index ?? text.length).trim().replace(/(?:[;,.]|\s+or)+$/i, '').trim();
            const [head, ...rest] = s.split(/:\s|\s+[—–]\s+/), label = head.replace(/[*_`]/g, '').trim();
            const rec = /\brecommended\b/i.test(s) && !/\brecommended\b/i.test(label);

            return { label: rec ? `${label} (recommended)` : label, desc: rest.join(': ') };
        });
        const head = text.slice(0, marks[0].index).replace(/[\s—–:;,-]+$/, '').split(/\s+[—–]\s+/);

        return { question: head.at(-1), context: head.slice(0, -1).join(' — '), options };
    }

    return null;
}

const HEADS_UP = /^[ \t]*\*\*Heads-up:?\*\*:?[ \t]*(\S.*)$\n?/im;

// The reply's closing "**In flight**" list (homebase-rules.md), cut off so its rows never read as options or the ask.
const IN_FLIGHT = /(?:^|\n)[ \t]*(?:#+[ \t]*|\*\*)In flight\b[\s\S]*$/i;
const withoutInFlight = text => (text ?? '').replace(IN_FLIGHT, '').trim();

// An explicit "**Options**" header and the list under it, as the exact substring of the text, else null.
function optionsBlock(text) {

    const m = text.match(/^[ \t]*\*\*Options\b.*$/im);
    if (!m) {
        return null;
    }

    const lines = text.slice(m.index).split('\n');
    let end = 1;
    for (let k = 1; k < lines.length; k++) {
        if (LIST_ITEM.test(lines[k]) || /^\s+\S/.test(lines[k])) {
            end = k + 1;
        } else if (lines[k].trim()) {
            break;
        }
    }

    return end > 1 ? lines.slice(0, end).join('\n') : null;
}

const MAX_CHIPS = 6;
const LABEL_CHARS = 60;

// One chip label per top-level item of an askList: its bold lead, else the text before " — " or ": ", keeping a
// "(Recommended)" after it. [] when it doesn't look like a set of choices (fewer than 2, more than MAX_CHIPS).
export function optionLabels(options) {

    const labels = (options ?? '').split('\n').filter(l => /^\S/.test(l) && LIST_ITEM.test(l)).map(l => {
        const s = l.replace(/^(?:[-*+]|\d+[.)]|[A-Da-d][.)])\s+/, '').trim();
        const bold = s.match(/^\*\*(.+?)\*\*:?(\s*\(recommended\))?/i);
        const label = (bold ? bold[1] + (bold[2] ?? '') : s.split(/\s+[—–-]\s+|:\s/)[0])
            .replace(/[*_`]/g, '').replace(/[:.]$/, '').trim();

        return label.length > LABEL_CHARS ? `${label.slice(0, LABEL_CHARS - 1).trim()}…` : label;
    }).filter(Boolean);

    return labels.length >= 2 && labels.length <= MAX_CHIPS ? [...new Set(labels)] : [];
}

// A question's chips: one per option it lists, else Yes / No (/ Do both), else the choices a needs-you reply names in
// its TLDR or Waiting on you ("Yes or later", "say go").
export const replyChips = i => {
    const labels = optionLabels(i.options);
    if (labels.length) {
        return labels;
    }
    const asked = waitingAsk(i.waiting);
    if (asked) {
        return asked.options.map(o => o.label);
    }
    const yesNo = quickReplies(i.tldr, withoutInFlight(i.text));
    return yesNo.length || !i.needsYou ? yesNo : namedChoices(`${i.tldr ?? ''}\n${i.waiting ?? ''}`);
};

// "say go" → [Go]; a sentence that is just "A or B" ("…merge now? Yes or later.") → [A, B]; else [].
// ponytail: one or two words a side only; longer phrasings get no chips.
export function namedChoices(text) {

    const flat = text.replace(/[*_`"“”]/g, ''), cap = w => w[0].toUpperCase() + w.slice(1);
    const say = flat.match(/\bsay\s+'?(\w+)/i);
    if (say) {
        return [cap(say[1])];
    }
    for (const part of flat.split(/[.?!;:\n]/)) {
        const m = part.trim().match(/^(\w+(?: \w+)?),? or (\w+(?: \w+)?)$/i);
        if (m) {
            return [cap(m[1]), cap(m[2])];
        }
    }

    return [];
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)]|[A-Da-d][.)]|\**Option\b)\s/;

// The choices in a message that asks something: its last list, with the line just above that introduces it, as the
// exact substring of the text, when that line asks a question (or the items are "**Option …**"), else null. The page
// keeps it out of the fold so the options show next to the TLDR.
export function askList(text) {

    const parts = (text ?? '').split(/(\n\s*\n)/); // paragraphs at even indexes, their separators between
    const listy = p => {
        const lines = p.split('\n'), first = lines.findIndex(l => LIST_ITEM.test(l));
        return first >= 0 && lines.slice(first).every(l => LIST_ITEM.test(l) || /^\s/.test(l));
    };
    let end = parts.length - 1;
    while (end >= 0 && !listy(parts[end])) {
        end -= 2;
    }
    if (end < 0) {
        return null;
    }
    let start = end;
    while (start >= 2 && listy(parts[start - 2])) {
        start -= 2;
    }
    if (start >= 2 && !parts[start - 2].includes('\n') && /[:?][*_\s]*$/.test(parts[start - 2])) {
        start -= 2;
    }

    // a choice, not a "what changed" list: the line above it asks a question, or its items are "**Option …**"
    const list = parts.slice(start, end + 1).join(''), lines = list.split('\n'), first = lines.findIndex(l => LIST_ITEM.test(l));
    const lead = lines.slice(0, first).filter(l => l.trim()).at(-1) ?? '';

    return /\?[*_\s]*$/.test(lead) || /^\s*\**Option\b/.test(lines[first]) ? list : null;
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
