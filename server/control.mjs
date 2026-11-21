// The POST actions on a session: type into its tmux session, interrupt, /clear, /compact.
import { stat, readFile, writeFile } from 'node:fs/promises';
import { sessions } from './sessions.mjs';
import { liveSessions } from './transcripts.mjs';
import { versionWarning, settingsPath, backupSettings } from './setup.mjs';
import { refuseIfTrustDialog, cancelQuestion, parseDialog, parseQuestion, questionOpen, capture, inputLine, promptBack, freeTextOption, typeAnswer } from './startup.mjs';
import { tmux, tmuxName, tmuxFor, aliases, clears, tmuxSession, sendSteps, refuseIfLiveElsewhere, ELSEWHERE, sleep, NEW_TMUX, OUR_TMUX, withLock } from './tmux.mjs';

// Only known sessions, only their recorded cwd.
async function resumable(id) {

    if (!/^[0-9a-f-]{36}$/.test(id ?? '')) {
        throw Object.assign(new Error('bad id'), { status: 400 });
    }

    const s = (await sessions()).find(x => x.id === id);
    if (!s?.cwd) {
        throw Object.assign(new Error('unknown session'), { status: 404 });
    }
    try {
        await stat(s.cwd);
    } catch {
        throw Object.assign(new Error(`folder is gone: ${s.cwd}`), { status: 409 });
    }

    return s;
}

// `/model <alias>` makes Claude Code save the model as the global default; a pick from the chat is for that chat only.
// Returns restore(): waits (up to waitMs) for the top-level "model" in settings.json to change, then puts the old value back (or removes the key).
// The first restore of each server run copies the file first (setup's backupSettings): this is a write the user didn't ask for by name.
// ponytail: a /model typed by hand in the same few seconds gets reverted too; the rest of the file is kept, but reformatted as 2-space JSON
const backedUp = new Set();
export async function keepModelSetting(path = settingsPath(), { waitMs = 5000, nap = sleep } = {}) {

    const read = async () => JSON.parse(await readFile(path, 'utf8'));
    const old = await read();
    const had = 'model' in old;

    return async () => {
        for (let waited = 0; waited <= waitMs; waited += 250) {
            const now = await read();
            if (now.model !== old.model || 'model' in now !== had) {
                if (had) {
                    now.model = old.model;
                } else {
                    delete now.model;
                }
                if (!backedUp.has(path)) {
                    backupSettings(path);
                    backedUp.add(path);
                }
                await writeFile(path, JSON.stringify(now, null, 2) + '\n');

                return true;
            }
            await nap(250);
        }

        return false;
    };
}

// Appended where the screen didn't parse (no input box, a question we can't read): a newer Claude Code is the likely cause
const versionNote = () => (versionWarning() ? ` (${versionWarning()})` : '');
const conflict = msg => Object.assign(new Error(msg), { status: 409 });
// The tmux a chat types into. Refused when the registry shows another chat in it: a /clear made that tmux the other chat's,
// and keys meant for this one would land there. ponytail: never redirected; the page already follows clearedFrom to the successor
const targetOf = (id, live) => {
    const name = tmuxFor(id, aliases, live);
    if (live && [...live].some(([other, t]) => other !== id && t === name)) {
        throw conflict('This chat was cleared and continues as another chat — open that one');
    }
    return name;
};
const BOOT_MS = 30_000;
const COMPACTING = /^\S Compacting conversation…/m; // its spinner line, tests/fixtures/pane-compacting.txt
export const NEEDS_CLICK = 'Claude is showing a question that typing can\'t answer: pick one of its options on the card above';

export const ANSWER_FIRST = 'Claude is asking a question: answer it in the chat first';

// Types `text` into the session's tmux, starting one (claude --resume) when none runs. Claude Code's registry (reg) says
// which tmux a live session is in; without a registry, a dead tmux plus a fresh transcript write means another terminal.
// typed: the user wrote this text, so an open question or permission prompt is declined (Esc) for it; a button's canned
// message is refused instead, as declining would reject the tool and interrupt the turn behind the user's back.
// A question with a text box ("Type something.") is answered there by one typed line; answered() tells the caller so.
export async function send(id, text, session = null, { tm = tmux, nap = sleep, reg = liveSessions, waitMs = BOOT_MS, after = null, typed = false, answered = null } = {}) {

    session ??= await resumable(id);
    const live = await reg();
    const first = targetOf(id, live);
    sendSteps(first, text); // an empty message is refused before anything is touched

    return withLock(first, async () => {

        if (live?.has(id) && !OUR_TMUX.test(live.get(id) ?? '')) {
            throw conflict(ELSEWHERE);
        }

        let name = first;
        let started = false;
        try {
            await tm(['has-session', '-t', `=${name}`]);
        } catch {
            if (live?.has(id)) {
                throw conflict(ELSEWHERE); // running in a cc-* tmux this server can't see
            }
            aliases.delete(id); // the aliased tmux session is gone: start one of its own
            name = tmuxName(id);
            if (!live) {
                refuseIfLiveElsewhere(Date.now() - session.updated);
            }
            await tm(['new-session', '-d', ...tmuxSession(id, session.cwd)]);
            started = true;
            await waitForPrompt(name, { tm, nap, waitMs });
        }

        await refuseIfTrustDialog(name, { tm });
        if (!started) {
            await closePanel(name, { tm, nap }); // typing into a panel left open would go nowhere
        }
        // a dialog Esc can't decline ("Switch model?"), or asking with no question on screen to cancel: typing would land
        // in whatever dialog is up instead
        const pane = started ? '' : await capture(name, tm);
        if (!started && !questionOpen(pane) && parseQuestion(pane)) {
            throw conflict(NEEDS_CLICK);
        }
        // Claude queues what's typed during a compaction with no text in the transcript, so the page can't show it (it turns
        // "not confirmed"); a /compact from another page would run a second compaction after it
        if (COMPACTING.test(pane)) {
            throw conflict('Claude is compacting the conversation: send again when it\'s done');
        }
        // (asking with the input box back is a stale marker: a permission prompt answered, its tool still running)
        if (!started && session.asking && !questionOpen(pane) && !promptBack(pane)) {
            throw conflict(`Claude is asking something Homebase can't see: answer it in the terminal${versionNote()}`);
        }
        if (!typed && questionOpen(pane)) {
            throw conflict(ANSWER_FIRST);
        }
        const steps = sendSteps(name, text);
        if (questionOpen(pane) && freeTextOption(pane) >= 0 && steps.length === 2 && !steps[0].at(-1).startsWith('/')) {
            await typeAnswer(name, text, { tm, nap });
            answered?.();
        } else {
            await cancelQuestion(name, { tm, nap });
            await typeSteps(name, steps, { tm, nap });
        }
        await after?.(name); // still under the lock

        return name;
    });
}

// The chat's Claude runs in two of Homebase's tmux sessions (send uses the newest): a note naming the older ones to close, else null.
// ponytail: no Close button; the note gives the tmux command
export async function runningTwice(id, reg = liveSessions) {

    const older = (await reg())?.twice?.get(id);

    return older?.length ? `This chat is running twice; sent to the newest. Close the older one: tmux kill-session -t ${older.join(' / ')}` : null;
}

// tmux name -> text a refused send left typed in Claude's input box
const leftTyped = new Map();

// Enter goes separately, later, so Claude doesn't treat it as part of the typed/pasted text; and not into a dialog that
// opened meanwhile (the text stays in the input box, and sending the same text again only presses Enter).
// ponytail: a different text is typed after the leftover; clearing the box needs keys whose meaning varies by Claude version
async function typeSteps(name, steps, { tm = tmux, nap = sleep } = {}) {

    const text = steps[0].at(-1);
    const left = leftTyped.get(name);
    leftTyped.delete(name);
    if (left === text) {
        steps = steps.slice(-1);
    }

    for (const args of steps) {
        if (args.at(-1) === 'Enter') {
            await nap(300);
            if (questionOpen(await capture(name, tm))) {
                leftTyped.set(name, text);
                throw conflict('A question showed up while typing: check it, then send again');
            }
        }
        await tm(args);
    }
}

// Polls until Claude's prompt (or a startup dialog, which the caller handles) shows. -> the pane; 504 after waitMs
async function waitForPrompt(name, { tm = tmux, nap = sleep, waitMs = BOOT_MS } = {}) {

    for (let waited = 0; waited < waitMs; waited += 500) {
        await nap(500);
        const pane = await capture(name, tm);
        if (promptUp(pane) || parseDialog(pane)) {
            return pane;
        }
    }

    throw Object.assign(new Error(`Claude started but its prompt didn't show within ${waitMs / 1000}s${versionNote()}`), { status: 504 });
}

// A new project's chat before its transcript exists: typed into its cc-new-<name> tmux session, if that is running.
export async function sendToNew(name, text, { tm = tmux, nap = sleep } = {}) {

    if (!NEW_TMUX.test(name ?? '')) {
        throw Object.assign(new Error('bad tmux name'), { status: 400 });
    }

    const steps = sendSteps(name, text);
    await withLock(name, async () => {
        try {
            await tm(['has-session', '-t', `=${name}`]);
        } catch {
            throw conflict(`${name} isn't running`);
        }

        await refuseIfTrustDialog(name, { tm });
        await cancelQuestion(name, { tm, nap });
        await typeSteps(name, steps, { tm, nap });
    });
}

// Escape interrupts Claude's turn, so queued messages are handled right away. Only in our own tmux session.
export async function interrupt(id, { tm = tmux, reg = liveSessions } = {}) {

    await resumable(id);
    const name = targetOf(id, await reg());

    await withLock(name, async () => {
        try {
            await tm(['has-session', '-t', `=${name}`]);
        } catch {
            throw conflict("Session isn't running in Homebase's tmux");
        }

        await tm(['send-keys', '-t', name, 'Escape']);
    });
}

// /compact needs an idle Claude: mid-turn it would queue behind the work, and while asking it would answer the question.
export function refuseIfBusy(s) {
    if (s.status === 'working' || s.asking) {
        throw Object.assign(new Error('busy'), { status: 409 });
    }
}

// Typed after /compact by auto-compact and the + menu alike: what the summary keeps.
export const COMPACT_INSTRUCTIONS = "Keep it short (under 400 words): the user's open requests, decisions and preferences stated in this chat, work in progress and running helpers with what each does, open questions waiting on the user, and key file paths and commit ids. Drop finished work details, tool output and anything already in the repo or the commit history.";

// Types /compact (same checks as send). Unlike /clear the session id stays, so nothing is remembered.
export async function compactChat(id) {

    const s = await resumable(id);
    refuseIfBusy(s);

    await send(id, `/compact ${COMPACT_INSTRUCTIONS}`, s);
}

// Types /clear (same checks as send) and remembers it, so the next session list maps the new transcript to this tmux session.
export async function clearChat(id) {

    const s = await resumable(id);
    const c = { from: id, tmux: targetOf(id, await liveSessions()), cwd: s.cwd, clearedAt: Date.now() };
    clears.push(c);
    try {
        c.tmux = await send(id, '/clear', s, { typed: true }); // send may have replaced a dead aliased tmux session
    } catch (e) {
        clears.splice(clears.indexOf(c), 1);
        throw e;
    }
}

// Lines as a chat bubble shows them: no right-edge ↓ scroll marker, no "Esc to close" footer, dedented. -> text or null
function tidy(lines) {

    const kept = lines.map(l => l.replace(/\s+[↑↓]$/, '').trimEnd()).filter(l => !/Esc to (close|cancel|go back)/.test(l));
    const pad = Math.min(...kept.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));

    return kept.map(l => l.slice(pad)).join('\n').replace(/\n{3,}/g, '\n\n').trim() || null;
}

// A slash command's full-screen panel (/usage, /status, /config, /help, /model, /resume…; tests/fixtures/pane-*.txt): the
// lines under its ▔ top rule, with no input box below and no question the card can answer ("Switch model?" has a ▔ too). -> text or null
export function panelText(pane) {

    const lines = String(pane ?? '').split('\n');
    const top = lines.findLastIndex(l => /^\s*▔{3,}/.test(l));
    if (top < 0 || inputLine(lines.slice(top)) >= 0 || parseQuestion(pane)) {
        return null;
    }

    return tidy(lines.slice(top + 1));
}

// What a command printed under its echoed "❯ /cmd" (/context, /model opus…) down to the input box; a right-aligned
// notice just above the box ("✔ Update installed") left out. -> text or null
export function commandOutput(pane, cmd) {

    const lines = String(pane ?? '').split('\n');
    const input = inputLine(lines);
    const echo = lines.slice(0, Math.max(input, 0)).findLastIndex(l => l.trimEnd() === `❯ ${cmd}`);
    if (input < 0 || echo < 0) {
        return null;
    }
    const out = lines.slice(echo + 1, input - 1).map(l => l.replace(/^(\s*)⎿/, '$1 '));
    if (/^ {40}/.test(out.at(-1) ?? '')) {
        out.pop();
    }

    return tidy(out);
}

const PANEL_STUCK = "A Claude Code panel is open in this chat and Esc didn't close it: press Stop, or close it in the terminal";

// Presses Esc while a panel is open, up to three times (/config's first Esc only leaves its search box); 409 if it stays.
async function closePanel(name, { tm = tmux, nap = sleep } = {}) {

    for (let tries = 0; tries < 3; tries++) {
        if (panelText(await capture(name, tm)) === null) {
            return;
        }
        await tm(['send-keys', '-t', `=${name}:`, 'Escape']);
        await nap(400);
    }
    if (panelText(await capture(name, tm)) !== null) {
        throw conflict(PANEL_STUCK);
    }
}

// After typing a slash command: waits (up to waitMs) for Claude's prompt or a panel. A panel's text is read, then it is
// closed so the chat stays usable; at the prompt, what the command printed. -> { text, pick, stuck? } or null (nothing to
// show, or still busy: a running /compact never gets an Esc). pick: a picker (a ❯ selection) whose choice can't be made from here.
export async function settleCommand(name, cmd, { tm = tmux, nap = sleep, waitMs = 3000 } = {}) {

    for (let t = 0; t < waitMs; t += 250) {
        await nap(250);
        const pane = await capture(name, tm);
        const lines = pane.split('\n');
        const input = inputLine(lines);
        if (panelText(pane) !== null) {
            await nap(500); // a panel that loads (/usage) fills in
            const text = panelText(await capture(name, tm)) ?? panelText(pane);
            const result = { text, pick: text.includes('❯') };
            try {
                await closePanel(name, { tm, nap });
            } catch (e) {
                result.stuck = e.message;
            }

            return result;
        }
        if (input >= 0 && lines[input].replace(/^[│\s]*[❯>]|│\s*$/g, '').trim() !== cmd) { // submitted, not still in the box
            const text = commandOutput(pane, cmd);
            if (/^[·✢✳✶✻✽*] \S.*…/m.test(text ?? '')) {
                continue; // its spinner ("· Imagining…"): /context still counting
            }

            return text ? { text, pick: false } : null;
        }
    }

    return null;
}

// Claude's input line: a ❯ or > at the start of a (boxed) line, with no startup dialog on screen
export const promptUp = pane => /^[│\s]*[❯>]/m.test(pane) && !parseDialog(pane);

// Kills the chat's Homebase tmux session and resumes it, so Claude reloads (e.g. an edited homebase-rules.md). Refused while Claude
// is busy. No live-elsewhere check: Homebase closed the old one itself. Answers once the new Claude shows its prompt.
export async function restartChat(id, { tm = tmux, nap = sleep, waitMs = 20_000, session = null, reg = liveSessions } = {}) {

    const s = session ?? await resumable(id);
    refuseIfBusy(s);
    const old = targetOf(id, await reg());

    return withLock(old, async () => {
        try {
            await tm(['has-session', '-t', `=${old}`]);
        } catch {
            throw conflict("Not running in Homebase's tmux");
        }

        await tm(['kill-session', '-t', `=${old}`]);
        aliases.delete(id);
        const name = tmuxName(id);
        await tm(['new-session', '-d', ...tmuxSession(id, s.cwd)]);
        await waitForPrompt(name, { tm, nap, waitMs });

        return name;
    });
}
