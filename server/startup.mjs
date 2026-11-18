// Claude Code's blocking startup dialogs (workspace trust, first-run prompts) in a Homebase tmux pane: read them off the screen
// and answer by moving the ❯ selection to the option the user clicked. Homebase never picks an option by itself.
import { tmux, sleep } from './tmux.mjs';

const NAME = /^cc-[A-Za-z0-9._-]{1,120}$/;
const MAX_OPTIONS = 10;
const CACHE_MS = 3000;
const cache = new Map(); // tmux name -> { at, dialog }

// "❯ option … Enter to confirm": the contiguous lines around the ❯ line are the options. -> { question, options, selected } or null
export function parseDialog(pane) {

    const lines = String(pane ?? '').split('\n').map(l => l.replace(/\s+$/, ''));
    const at = lines.findIndex(l => /^\s*❯\s+\S/.test(l));
    if (at < 0 || !lines.slice(at).some(l => /enter to (confirm|select)/i.test(l))) {
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
const capture = (name, tm) => tm(['capture-pane', '-p', '-t', `=${name}:`]).then(r => r?.stdout ?? '', () => '');

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
// then re-reads the pane and fails if the same dialog is still up.
export async function answerStartup(name, index, label, { tm = tmux, nap = sleep } = {}) {

    check(name);
    cache.delete(name);
    const dialog = parseDialog(await capture(name, tm));
    if (!dialog) {
        throw Object.assign(new Error('No startup question is showing any more'), { status: 409 });
    }
    if (!Number.isInteger(index) || dialog.options[index] === undefined || dialog.options[index] !== label) {
        throw Object.assign(new Error('The startup question changed, check it and try again'), { status: 409 });
    }

    for (const args of selectSteps(name, dialog.selected, index)) {
        if (args.at(-1) === 'Enter') {
            await nap(200);
        }
        await tm(args);
    }

    await nap(700);
    const after = parseDialog(await capture(name, tm));
    cache.delete(name);
    if (after && after.question === dialog.question && after.options.join('|') === dialog.options.join('|')) {
        throw Object.assign(new Error('The startup question is still showing, answer it in the terminal'), { status: 502 });
    }
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
