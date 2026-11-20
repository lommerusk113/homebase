// Claude Code's blocking startup dialogs (workspace trust, first-run prompts) in a Homebase tmux pane: read them off the screen
// and answer by moving the ❯ selection to the option the user clicked. Homebase never picks an option by itself.
import { tmux, sleep } from './tmux.mjs';
import { RISKY } from './transcripts.mjs';
import { seenHash } from '../public/core.js';

const NAME = /^cc-[A-Za-z0-9._-]{1,120}$/;
const MAX_OPTIONS = 10;
const CACHE_MS = 3000;
const cache = new Map(); // tmux name -> { at, dialog }

// "❯ option … Enter to confirm": the contiguous lines around the last ❯ line above the hint are the options (a ❯ further
// up is the user's own echoed prompt). -> { question, options, selected } or null
export function parseDialog(pane) {

    const lines = String(pane ?? '').split('\n').map(l => l.replace(/\s+$/, ''));
    const hint = lines.findLastIndex(l => /enter to (confirm|select)/i.test(l));
    const at = lines.slice(0, Math.max(hint, 0)).findLastIndex(l => /^\s*❯\s+\S/.test(l));
    if (at < 0) {
        return null;
    }

    let from = at, to = at;
    while (from > 0 && lines[from - 1].trim()) {
        from--;
    }
    while (to + 1 < lines.length && lines[to + 1].trim() && !/enter to (confirm|select)/i.test(lines[to + 1])) {
        to++;
    }
    const block = lines.slice(from, to + 1);
    if (block.length < 2 || block.length > MAX_OPTIONS) {
        return null;
    }
    const options = block.map(l => l.replace(/^\s*❯?\s*(\d+\.\s+)?/, '').trim());

    // the question: nearest paragraph above the options that asks something, else the nearest one
    const paras = lines.slice(0, from).join('\n').split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
    const question = [...paras].reverse().find(p => p.includes('?')) ?? paras.at(-1) ?? '';

    return question ? { question, options, selected: at - from } : null;
}

// tmux argument lists that move the highlight from `from` to `to` and confirm
export function selectSteps(name, from, to) {

    const n = to - from;
    const target = `=${name}:`;

    return [...(n ? [['send-keys', '-t', target, ...Array(Math.abs(n)).fill(n > 0 ? 'Down' : 'Up')]] : []), ['send-keys', '-t', target, 'Enter']];
}

const check = name => {
    if (!NAME.test(name ?? '')) {
        throw Object.assign(new Error('bad tmux session'), { status: 400 });
    }
};

// ponytail: only cc-* sessions; a capture failure (no such session) just means no dialog
export const capture = (name, tm = tmux) => tm(['capture-pane', '-p', '-t', `=${name}:`]).then(r => r?.stdout ?? '', () => '');

export async function startupDialog(name, { tm = tmux, now = Date.now() } = {}) {

    check(name);
    const hit = cache.get(name);
    if (hit && now - hit.at < CACHE_MS) {
        return hit.dialog;
    }
    const dialog = parseDialog(await capture(name, tm));
    cache.set(name, { at: now, dialog });

    return dialog;
}

// Selects option `index` (whose text must be `label`, so a dialog that changed meanwhile isn't answered blind) and confirms;
// then re-reads the pane and fails if the same dialog is still up. `parse` reads the dialog: parseDialog or parseQuestion.
// `seen` (the card's seenHash) must match the prompt on screen: a command that changed since the card drew is not approved.
export async function answerStartup(name, index, label, { tm = tmux, nap = sleep, parse = parseDialog, seen = null } = {}) {

    check(name);
    cache.delete(name);
    const dialog = parse(await capture(name, tm));
    if (!dialog) {
        throw Object.assign(new Error('No question is showing any more'), { status: 409 });
    }
    if (seen !== null && seenHash(dialog) !== seen) {
        throw Object.assign(new Error('The command changed — check it again'), { status: 409 });
    }
    if (!Number.isInteger(index) || dialog.options[index] === undefined || dialog.options[index] !== label) {
        throw Object.assign(new Error('The question changed, check it and try again'), { status: 409 });
    }

    // Enter only once the ❯ is seen on the chosen option: a just-drawn dialog can drop the arrow keys, and Enter then
    // confirms the default ("No, exit" quits Claude)
    let on = dialog.selected;
    for (let tries = 0; on !== index; tries++) {
        if (tries === 5) {
            throw Object.assign(new Error("Couldn't select that option, answer it in the terminal"), { status: 502 });
        }
        for (const args of selectSteps(name, on, index).slice(0, -1)) {
            await tm(args);
        }
        await nap(300);
        const now = parse(await capture(name, tm));
        if (!now || now.question !== dialog.question || now.detail !== dialog.detail || now.options.join('|') !== dialog.options.join('|')) {
            throw Object.assign(new Error('The question changed, check it and try again'), { status: 409 });
        }
        on = now.selected;
    }
    await tm(selectSteps(name, index, index)[0]);

    await nap(700);
    const after = parse(await capture(name, tm));
    cache.delete(name);
    if (after && after.question === dialog.question && after.detail === dialog.detail && after.options.join('|') === dialog.options.join('|')) {
        throw Object.assign(new Error('The question is still showing, answer it in the terminal'), { status: 502 });
    }
}

// Claude's own text-box entry under an AskUserQuestion, never answered from here (the chat input declines and types instead).
// "Chat about this" is answerable: it declines the question as "the user wants to clarify" and Claude asks what to talk about.
const FREE_FORM = /^type something\.?$/i;
const OPTION = /^(?: {0,3}|\s*❯\s+)(\d+)\.\s+(.+)$/;

// An AskUserQuestion on screen: the question above "1." and the numbered options down to "Enter to select", each
// option's indented lines its description. One question at a time (a ☐ tab bar above is ignored); a multi-select
// ([ ] boxes) isn't parsed. The last step of several questions, "Review your answers", has no hint: its options run to
// the bottom and its question is the answers summary. A tool permission prompt ("Do you want to proceed?") ends in
// "Esc to cancel" instead: its question is the dialog's title and ask sections (╌ rules between) joined by " · ", Tips dropped,
// and the command or diff between them its whole `detail`, `risky` when it matches RISKY; tests/fixtures/permission-*.txt
// are real ones. A dialog with no footer at all ("Switch model?" after /model, tests/fixtures/dialog-switch-model.txt) counts
// when two or more options, nothing else, end the pane with no ─ rule around them (the input box has one). │ box borders are stripped. -> { question, options, descriptions, selected, detail?, risky? } or null
export function parseQuestion(pane) {

    // a question taller than the pane is clipped at the top, with a "↑ 5 more lines" scroll marker: not part of any option
    let lines = String(pane ?? '').split('\n').map(l => l.replace(/^\s*│ ?|\s*│\s*$/g, '').replace(/\s+$/, '')).filter(l => !/^\s*[↑↓] \d+ more lines?$/.test(l));
    const hint = lines.findLastIndex(l => /enter to select/i.test(l));
    const review = lines.findLastIndex(l => /^\s*Review your answers$/.test(l));
    const esc = lines.findLastIndex(l => /^\s*Esc to cancel/.test(l));
    const footer = esc >= 0 && lines.slice(esc + 1).filter(l => l.trim()).length <= 2; // at the bottom, not quoted in the transcript
    const bare = hint < 0 && review < 0 && !footer;
    if (bare) { // its options are indented: drop the ❯ line's indent
        const pad = lines.findLast(l => /^\s*❯\s+\d+\.\s/.test(l))?.match(/^ */)[0] ?? '';
        lines = lines.map(l => (l.startsWith(pad) ? l.slice(pad.length) : l));
    }
    const end = hint >= 0 ? hint : review >= 0 || bare ? lines.length : esc;
    const first = lines.slice(0, end).findLastIndex(l => OPTION.exec(l)?.[1] === '1');
    const rule = l => /^[\s─]+$/.test(l);
    if (first < 0 || (bare && (first === 0 || rule(lines[first - 1]) || lines.slice(first).some(rule)))) {
        return null;
    }

    // a line filling the pane's width (its longest line, the dialog's rule) was cut mid-word: its continuation joins without a space
    const width = Math.max(...lines.map(l => l.length));
    const options = [], descriptions = [];
    let selected = -1;
    for (const [i, l] of lines.slice(first, end).entries()) {
        const m = OPTION.exec(l);
        if (m && Number(m[1]) === options.length + 1) {
            selected = l.includes('❯') ? options.length : selected;
            options.push(m[2].trim());
            descriptions.push('');
        } else if (l.trim() && !/^[\s─]+$/.test(l)) {
            const cut = lines[first + i - 1].length === width && descriptions.at(-1);
            descriptions[options.length - 1] = `${descriptions.at(-1)}${cut ? '' : ' '}${l.trim()}`.trim();
        }
    }
    if (selected < 0 || options.some(o => /^\[.?\]/.test(o)) || (bare && (options.length < 2 || descriptions.some(Boolean)))) {
        return null;
    }

    let from = first;
    while (from > 0 && !lines[from - 1].trim()) {
        from--;
    }
    let top = hint < 0 && review >= 0 && review < from ? review : from;
    while (top > 0 && lines[top - 1].trim() && !/^[\s─]+$/.test(lines[top - 1])) {
        top--;
    }
    // a permission prompt's ╌ sections: its title lines, the command or diff (kept whole, as `detail`), the ask
    const sections = [[]];
    for (const l of lines.slice(top, from)) {
        if (/^[\s╌]+$/.test(l)) {
            sections.push([]);
        } else if (l.trim() && !/^\s*Tip:/.test(l)) {
            sections.at(-1).push(l);
        }
    }
    const trim = s => s.map(l => l.trim());
    const parts = sections.length < 2 ? [trim(sections[0]).join(' ')] : [trim(sections[0]).join(' · '), trim(sections.at(-1)).join(' ')];
    const question = parts.filter(Boolean).join(' · ').replace(/\s*●\s*/g, ' · ');
    const block = sections.slice(1, -1).flat();
    const indent = Math.min(...block.map(l => l.match(/^ */)[0].length));
    const detail = block.map(l => l.slice(indent)).join('\n');

    return question && !/^[☐☒✔←]/.test(question)
        ? { question, options, descriptions, selected, ...(detail && { detail, risky: RISKY.test(detail) }) } : null;
}

export async function paneQuestion(name, { tm = tmux } = {}) {
    check(name);

    return parseQuestion(await capture(name, tm));
}

// After a /model pick only: Claude Code asks "Switch model?" to repeat the choice the user just made, so Enter confirms it.
// Only that dialog (first option "Yes, switch to …", the ❯ on it); any other, or none within waitMs, is left alone for
// the card. -> true if confirmed
export async function confirmModelSwitch(name, { tm = tmux, nap = sleep, waitMs = 2000 } = {}) {

    check(name);
    for (let t = 0; t < waitMs; t += 250) {
        await nap(250);
        const q = parseQuestion(await capture(name, tm));
        if (q) {
            const ours = /^Yes, switch to /.test(q.options[0]) && q.selected === 0;
            if (ours) {
                await tm(['send-keys', '-t', `=${name}:`, 'Enter']);
                cache.delete(name);
            }

            return ours;
        }
    }

    return false;
}

// Picks option `index` (labelled `label`) of the AskUserQuestion on screen, never the "Type something." text box.
export async function answerQuestion(name, index, label, { tm = tmux, nap = sleep, seen = null } = {}) {
    if (!seen) {
        throw Object.assign(new Error('seen is required'), { status: 400 });
    }
    if (FREE_FORM.test(label ?? '')) {
        throw Object.assign(new Error('Answer that one in the terminal'), { status: 400 });
    }
    await answerStartup(name, index, label, { tm, nap, parse: parseQuestion, seen });
}

// The folder a workspace trust dialog names: the lines after "Accessing workspace:" up to a blank line, joined (a narrow pane wraps the path)
export const trustFolder = pane => {
    const m = String(pane ?? '').match(/Accessing workspace:[ \t]*\n(?:[ \t]*\n)?((?:[ \t]*\S[^\n]*\n)+?)(?:[ \t]*\n|[ \t]*Quick safety)/);

    return m ? m[1].split('\n').map(l => l.trim()).join('') || null : null;
};

// Typing into the trust dialog would press Enter on its default "No, exit" and quit Claude: refuse sends until it's answered.
export async function refuseIfTrustDialog(name, { tm = tmux } = {}) {
    const pane = await capture(name, tm);
    if (parseDialog(pane) && /Accessing workspace:/.test(pane)) {
        throw Object.assign(new Error('Claude is waiting for you to trust this folder: answer the startup question first'), { status: 409 });
    }
}

// An open question or permission prompt in a running chat: a ❯ selection over an "Esc to cancel" footer (not the trust dialog).
export function questionOpen(pane) {

    const lines = String(pane ?? '').split('\n').filter(l => l.trim());
    const hint = lines.findLastIndex(l => /Esc to cancel/.test(l));

    return hint >= lines.length - 3 && lines.slice(Math.max(0, hint - 40), hint).some(l => /^\s*❯\s+\S/.test(l)) && !/Accessing workspace:/.test(pane);
}

// A typed message instead of a click: Esc cancels the open question first, so the text arrives as a new message (Claude sees
// the question declined, then the message) instead of being typed into the options. -> true if one was cancelled
export async function cancelQuestion(name, { tm = tmux, nap = sleep } = {}) {

    check(name);
    if (!questionOpen(await capture(name, tm))) {
        return false;
    }
    await tm(['send-keys', '-t', `=${name}:`, 'Escape']);
    for (let t = 0; t < 3000; t += 250) {
        await nap(250);
        if (!questionOpen(await capture(name, tm))) {
            cache.delete(name);
            return true;
        }
    }
    throw Object.assign(new Error("Couldn't close Claude's question, answer it in the terminal"), { status: 502 });
}

// New project only: the user creating `dir` is consent to trust exactly that folder. Waits for the trust dialog, and answers
// "Yes" only when it names `dir` itself (not a parent or another folder). Anything else is left to the chat panel. -> true if answered
export async function trustNewProject(name, dir, { tm = tmux, nap = sleep, waitMs = 60_000 } = {}) {

    for (let t = 0; t < waitMs; t += 500) {
        const pane = await capture(name, tm);
        const dialog = parseDialog(pane);
        const yes = dialog?.options.findIndex(o => /^yes, i trust/i.test(o)) ?? -1;
        if (yes >= 0) {
            if (trustFolder(pane) !== dir) {
                return false;
            }
            try {
                await answerStartup(name, yes, dialog.options[yes], { tm, nap });
            } catch {
                return false;
            }

            return true;
        }
        await nap(500);
    }

    return false;
}
