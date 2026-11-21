// Chat column: bound to one master session, default the most recently active tracked one.
import { api, $, el, state, store, touch, visibleSessions, updateTitle, rich, foldable, foldLine, foldButton, commandRun, waButton, tooltip, chatStatus, friendly, seenHash, setOffline, setFormatWarn, ctxLevel, canCompact, autoCompactDue, compactNudgeDue, modelName, NEEDS_ANSWER, openDecision, waitsOnYou, markHandled } from './core.js';
import { renderBoard, sessionTopic } from './list.js';
import { cannedLabel } from './canned.js';
import { syncDiff } from './diff.js';

// Subagent and worktree sessions never become the chat's master on their own.
/** @param {Session} s */
export const isMaster = s => !s.sidechain && !/\/\.(claude\/)?worktrees\//.test(s.cwd || '');
// The chat sticks to the bound session (chat:<project>, else the legacy global pick) and only moves on its own to a
// Homebase /clear successor (clearedFrom). Nothing bound yet: the master with the latest real activity (lastActivity,
// from the server), never file mtime, which an idle claude process still bumps with bookkeeping lines.
/** @param {Session} s @returns {number} */
const activity = s => s.lastActivity ?? s.created ?? 0;
/** @param {Session[]} visible @param {string | null} bound @param {string | null} legacy @returns {Session | null} */
export function pickChat(visible, bound, legacy) {
    const byId = id => id && visible.find(s => s.id === id);
    const successor = x => visible.find(y => y.clearedFrom === x.id);
    // follow Homebase /clear successors to the newest
    let s = byId(bound) || byId(legacy);
    for (let next = s && successor(s); next; next = successor(next)) {
        s = next;
    }

    return s || visible.filter(isMaster).sort((a, b) => activity(b) - activity(a))[0] || null;
}
// A master in the bound session's project started after it and active since: offered as "Switch", never switched to
// on its own. Uses created and lastActivity, not mtime.
/** @param {Session[]} visible @param {Session | null} s @returns {Session | null} */
export function newerSession(visible, s) {

    if (!s) {
        return null;
    }

    const newer = visible.filter(x => x.id !== s.id && x.project === s.project && isMaster(x) && x.created > s.created && activity(x) > activity(s));

    return newer.sort((a, b) => activity(b) - activity(a))[0] || null;
}
const bindKey = () => `chat:${state.project}`;
// only sessions in the selected project(s)
/** @returns {Session | null} */
export const chatSession = () => (state.focus && visibleSessions().find(s => s.id === state.focus)) || pickChat(visibleSessions(), store.get(bindKey()), state.chat);
// The tmux session of the selected project's chat while it is still starting (no transcript yet), else null.
const startingTarget = () => (state.startingTmux === `cc-new-${state.project}` ? state.startingTmux : null);
let chatKey = null;
let stick = false; // set by a send: the next render scrolls to the bottom even if the user had scrolled up
const FEED_STEP = 60; // items per load; "Show earlier" adds this many
let feedMax = { sid: '', max: FEED_STEP };
/** @type {number | null} */
let keepFromBottom = null; // set by "Show earlier": the next render keeps the view where it was
let away = false; // the window lost focus or was hidden; back on focus

// cleared:<id> holds a timestamp (Clear view) or {"at","mode":"new"} (New conversation: the same cut, but not a "hidden" one)
/** @param {string | null} raw @returns {{ at: number, fresh: boolean }} */
export function clearState(raw) {
    let v;
    try {
        v = JSON.parse(raw);
    } catch {
        return { at: 0, fresh: false };
    }
    return v && typeof v === 'object' ? { at: Number(v.at) || 0, fresh: v.mode === 'new' } : { at: Number(v) || 0, fresh: false };
}

// The #msg draft and its selection per session in sessionStorage, so a reload doesn't lose typed text. Empty text
// removes it. ta is a wa-textarea (selection lives on its inner .input) or anything with value/selectionStart/End.
/** @param {Storage | null} storage @param {string | undefined} sid @param {WaTextarea | HTMLTextAreaElement} ta */
export function saveDraft(storage, sid, ta) {
    try {
        if (!sid) {
            return;
        }
        const sel = ('input' in ta && ta.input) || /** @type {HTMLTextAreaElement} */ (ta);
        if (ta.value) {
            storage.setItem(`draft:${sid}`, JSON.stringify({ text: ta.value, start: sel.selectionStart, end: sel.selectionEnd }));
        } else {
            storage.removeItem(`draft:${sid}`);
        }
    } catch {}
}
// Long pastes sit in the box as "[Pasted text #n +L lines]", like Claude Code, and expand on send. Kept in sessionStorage
// so a restored draft still expands after a reload.
const PASTE_LINES = 5, PASTE_CHARS = 800;
export const pasteLabel = (n, text) => `[Pasted text #${n} +${text.split('\n').length} lines]`;
export const isLongPaste = text => text.split('\n').length >= PASTE_LINES || text.length > PASTE_CHARS;
/** @param {string} text @param {Record<string, string>} pastes */
export const expandPastes = (text, pastes) => text.replace(/\[Pasted text #(\d+) \+\d+ lines\]/g, (m, n) => pastes[n] ?? m);
/** @returns {Record<string, string>} */
const loadPastes = () => {
    try {
        return JSON.parse(sessionStorage.getItem('pastes') ?? '{}') ?? {};
    } catch {
        return {};
    }
};
/** @param {string} text @returns {string} the label to insert */
function stashPaste(text) {
    const pastes = loadPastes();
    const n = Math.max(0, ...Object.keys(pastes).map(Number)) + 1;
    pastes[n] = text;
    try {
        sessionStorage.setItem('pastes', JSON.stringify(pastes));
    } catch {}

    return pasteLabel(n, text);
}
// Fills an empty ta from the saved draft; the selection is set once the component has rendered the value.
/** @param {Storage | null} storage @param {string} sid @param {WaTextarea} ta @returns {Promise<boolean>} */
export async function restoreDraft(storage, sid, ta) {
    try {
        const d = JSON.parse(storage.getItem(`draft:${sid}`));
        if (!d?.text || ta.value) {
            return false;
        }
        ta.value = d.text;
        await ta.updateComplete;
        if (d.start != null) {
            ta.setSelectionRange(d.start, d.end ?? d.start);
        }
        return true;
    } catch {
        return false;
    }
}
const draftStorage = () => {
    try {
        return sessionStorage;
    } catch {
        return null;
    }
};
let draftSid; // the chat the composer's text and error line belong to; null: a project still starting
// The composer follows the chat: switching saves the old chat's draft, clears the box and the error line, and restores the
// new chat's draft. A starting project's text stays for the session it becomes.
/** @param {string | null} sid */
function swapComposer(sid) {

    if (sid === draftSid) {
        return;
    }
    const ta = $('msg'), old = draftSid;
    draftSid = sid;
    if (old) {
        saveDraft(draftStorage(), old, ta);
        ta.value = '';
        $('c-err').textContent = '';
    }
    if (sid) {
        restoreDraft(draftStorage(), sid, ta);
    }
}

/** @param {string} id */
export function bindChat(id) {
    state.focus = null;
    state.chat = id;
    store.set('chat', id);
    store.set(bindKey(), id);
    renderBoard();
    refreshChat();
}

// Shows another chat's question in the pane (the "Needs you" rows, n, a chip) without rebinding the main chat;
// "← Main chat" (or Esc) goes back. The main chat itself just shows.
/** @param {string} id */
export function focusChat(id) {
    clearTimeout(returnTimer);
    nextId = null;
    $('c-next').hidden = true;
    state.focus = id;
    followFocus();
    renderBoard();
    refreshChat();
}
// A focused chat that was /clear'ed moves on to its successor, as the main binding does (pickChat); landing on the main chat ends the focus.
function followFocus() {
    const visible = visibleSessions();
    if (!state.focus || !visible.some(s => s.id === state.focus)) {
        return;
    }
    const to = pickChat(visible, state.focus, null)?.id;
    state.focus = to === pickChat(visible, store.get(bindKey()), state.chat)?.id ? null : to;
}
// After a focused question is answered: back to the main chat in 1.5s, unless another chat waits on the user, then
// the header offers "Next: <title> →" instead of jumping.
let returnTimer;
let nextId = null;
/** @param {string} sid */
function answered(sid) {
    if (sid !== state.focus) {
        return;
    }
    clearTimeout(returnTimer);
    returnTimer = setTimeout(() => {
        if (state.focus !== sid || $('msg').value) {
            return; // a follow-up being typed stays with this chat
        }
        const next = visibleSessions().find(o => o.id !== sid && waitsOnYou(o));
        if (next) {
            nextId = next.id;
            $('c-next').textContent = `Next: ${next.title || sessionTopic(next)} →`;
            $('c-next').hidden = false;
        } else {
            unfocusChat();
        }
    }, 1500);
}
export function unfocusChat() {
    clearTimeout(returnTimer);
    if (state.focus) {
        state.focus = null;
        renderBoard();
        refreshChat();
    }
}

// Stable colour per topic: one of TOPIC_HUES --t<n> tokens in styles.css, so bubbles on one task share a colour.
export const TOPIC_HUES = 8;
/** @param {string} topic */
export function topicHue(topic) {
    let h = 2166136261; // FNV-1a; low bits alone only see the chars' low bits, so fold the high half in
    for (const c of topic) {
        h = Math.imul(h ^ c.codePointAt(0), 16777619);
    }
    return ((h ^ (h >>> 16)) >>> 0) % TOPIC_HUES;
}

// Needs-you bubbles stay unread (a dot) until opened or answered. needs-seen:<sid> = { at, keys }: anything at or
// before `at` counts as seen, so the first load doesn't light up every old bubble.
const seenStore = sid => {
    try {
        return JSON.parse(store.get(`needs-seen:${sid}`)) || null;
    } catch {
        return null;
    }
};
function markRead(sid, key, b) {
    const v = seenStore(sid) ?? { at: 0, keys: [] };
    if (!v.keys.includes(key)) {
        store.set(`needs-seen:${sid}`, JSON.stringify({ ...v, keys: [...v.keys, key].slice(-200) }));
    }
    b.querySelector('.unread')?.remove();
}

// A big option button, as in the needs-you card and the ask card: a number badge, the label (its "(Recommended)" shown as
// a badge instead) and an optional description. ro: a read-only row (no pane to answer on). quiet: a plain text
// button with no number, for "Chat about this".
/** @param {string} label @param {number} n @param {{ desc?: string, ro?: boolean, quiet?: boolean }} [o] */
function optButton(label, n, { desc, ro, quiet } = {}) {

    if (quiet && !ro) {
        return waButton(desc ? `${label} ${desc}` : label, 'c-opt quiet', { variant: 'neutral', appearance: 'plain' }); // a grant's scope stays readable
    }
    const rec = /\(recommended\)/i.test(label);
    const text = label.replace(/\s*\(recommended\)/i, '');
    const b = ro ? el('div', 'c-opt ro', text) : waButton(text, `c-opt${rec ? ' primary' : ''}`, { variant: rec ? 'brand' : 'neutral', appearance: rec ? 'accent' : 'outlined' });
    const k = el('span', 'k', String(n + 1));
    k.slot = 'start';
    b.append(k);
    if (desc) {
        b.append(el('small', null, desc));
    }
    if (rec) {
        const r = el('span', 'rec', 'Recommended');
        r.slot = 'end';
        b.append(r);
    }

    return b;
}

// The numbered options of the question open in the pane: a startup or ask card's, else the strip's above the composer,
// else the newest reply row's. keys.js: a digit picks the one with that badge.
/** @returns {HTMLElement[]} */
export const openOptions = () => [.../** @type {NodeListOf<HTMLElement>} */ ([$('boot-opts'), $('ask-opts'), $('wait-opts'), [...document.querySelectorAll('#feed .replies')].at(-1)]
    .find(c => c?.checkVisibility() && c.querySelector('wa-button.c-opt .k'))?.querySelectorAll('wa-button.c-opt') ?? [])];

// Enter on a waiting row (keys.js): once that chat's question is drawn, the question takes the focus: its card, strip
// or bubble, never an option, so a second Enter answers nothing. Tab or a digit reaches the options from there.
/** @type {{ sid: string, until: number } | null} */
let wantQuestion = null;
/** @param {string} sid */
export function focusQuestionOf(sid) {
    wantQuestion = { sid, until: Date.now() + 5000 }; // ponytail: a chat that takes longer to load keeps focus on its row
    if (chatKey?.startsWith(sid)) { // already on screen
        focusWanted(sid);
    }
}
/** @param {string} sid */
function focusWanted(sid) {
    if (wantQuestion?.sid !== sid) {
        return;
    }
    const q = Date.now() < wantQuestion.until && /** @type {HTMLElement | null | undefined} */ (openOptions()[0]?.closest('.c-note, .bubble'));
    if (q || Date.now() >= wantQuestion.until) {
        wantQuestion = null;
    }
    if (q) {
        if (!q.hasAttribute('tabindex')) {
            q.tabIndex = -1;
        }
        q.focus({ preventScroll: true });
    }
}

// A keyboard press on a button that is about to go away (an option, Retry, Dismiss): the composer takes the focus, which
// would otherwise fall to <body>. Not after a tap (a phone would raise its keyboard) or a digit key (focus is elsewhere).
/** @param {Event} e */
function focusComposer(e) {
    if (/** @type {MouseEvent} */ (e).detail === 0 && document.activeElement === e.currentTarget) {
        $('msg').focus({ preventScroll: true });
    }
}

// "10:42" today, "Nov 14 10:42" before
/** @param {string} at */
function shortTime(at) {
    const d = new Date(at), hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hm}`;
}

// A slash command or `!` bash line on one line: the command and a hint of its result, opening to the panel or output
// as the terminal drew it. Several in a row: one line that opens to the list.
/** @param {ChatItem[]} run @param {string} sid */
function commandLine(run, sid) {
    const [i] = run, line = el('div', 'tools detail command'), top = el('div', 'c-cmd');
    line.dataset.key = `${sid}:${i.at}:${run.length > 1 ? 'cmds' : i.cmd}`;
    if (run.length > 1) {
        const list = el('div', 'c-cmds');
        list.append(...run.map(c => commandLine([c], sid)));
        line.append(foldLine(el('div', 'c-cmd', `${run.length} commands`), list, line.dataset.key));
        return line;
    }
    const lines = i.text ? i.text.split('\n') : [], long = lines.length > 1 || i.text.length > 80;
    top.append(el('span', 'mono', i.cmd), ...(i.text ? [el('span', 'c-result', long ? ` · ${lines.length} line${lines.length > 1 ? 's' : ''}` : ` · ${i.text}`)] : []));
    line.append(long ? foldLine(top, el('pre', 'c-panel mono', i.text), line.dataset.key) : top);
    if (i.hint) { // what to do about a picker left open: never folded away
        line.append(el('div', 'c-result', i.hint));
    }
    return line;
}

/** @param {ChatItem} i @param {string} sid @param {string | null} prevTopic @param {{ latest?: boolean, unread?: boolean, replies?: HTMLElement | null }} [look] */
function bubble(i, sid, prevTopic, look = {}) {
    if (i.role === 'tools') {
        const line = el('div', `tools${i.quiet ? ' quiet' : ''}${i.risky ? ' risky' : ''}`, i.detail ? undefined : i.text);
        if (i.risky) { // "Ran: git merge …" on one line, cut by the page (addShowMore drops the button where nothing is cut)
            const [, cmd, failed] = i.text.match(/^([\s\S]*?)( · \d+ failed)?$/), box = el('div', 'fold-line');
            const short = el('span', 'c-ran', cmd), full = el('div', 'c-ran-full', cmd);
            box.append(short, ...(failed ? [el('span', 'c-failed', failed)] : []), foldButton(full, `${sid}:${i.at}:ran`, short), full);
            line.replaceChildren(box);
        }
        if (i.detail) { // a finished agent's result, folded under its line
            line.classList.add('detail');
            line.append(...foldable(i.text, i.detail, `${sid}:${i.at}:detail`));
        }
        return line;
    }
    if (i.role === 'error') {
        return el('div', 'tools api-error', i.text);
    }
    if (i.role === 'compact') {
        return el('div', 'tools compact', i.text);
    }
    if (i.role === 'command') {
        return commandLine([i], sid);
    }
    // only the newest reply can be waiting on the user: an older one reads as a plain card
    const needs = i.role === 'assistant' && i.needsYou && !i.error && !!look.latest;
    const kind = i.role !== 'assistant' || i.error ? '' : needs ? ' needs' : ` fyi${look.latest ? ' latest' : ''}`;
    const b = el('div', `bubble ${i.role}${kind}${i.error || /** @type {OutboxItem} */ (i).unconfirmed ? ' failed' : ''}${i.interrupted ? ' interrupted' : ''}`);
    const key = `${sid}:${i.at}`;
    // who speaks, for a screen reader: sides and colours say it to the eye only
    if (i.role === 'user' || i.role === 'assistant') {
        b.setAttribute('role', 'group');
        b.setAttribute('aria-label', i.role === 'user' ? 'You' : needs ? 'Claude, needs you' : 'Claude');
    }
    // the interrupted mark gets its own tooltip instead of the timestamp
    if (i.at && !i.interrupted) {
        b.title = new Date(i.at).toLocaleString();
    }
    if (i.topic) {
        b.classList.add('topical');
        b.style.setProperty('--tc', `var(--t${topicHue(i.topic)})`);
    }
    // topic header only where it changes from Claude's previous bubble, so a run on one task reads as one block
    const head = i.topic && i.topic !== prevTopic;
    if (head || needs) {
        const row = el('div', 'b-topic');
        if (head) {
            row.append(el('span', 'b-topic-name', i.topic));
        }
        if (needs) {
            const pill = el('button', 'need-pill', 'needs you');
            pill.type = 'button';
            pill.onclick = jumpToNeeds;
            if (look.unread) {
                pill.prepend(el('span', 'unread'));
            }
            row.append(pill);
            if (i.id) {
                // Claude got it wrong (it only wants a later deploy, say): the reply stops needing you, here and on the board
                const done = el('button', 'need-done', '✓');
                done.type = 'button';
                done.title = 'Mark as handled';
                done.setAttribute('aria-label', 'Mark as handled');
                done.onclick = () => markHandled(sid, /** @type {string} */ (i.id)).then(refreshChat, err => showErr(err.message));
                row.append(done);
            }
            b.tabIndex = 0;
            for (const ev of ['click', 'focusin']) { // focus: reading by keyboard counts, Show more included
                b.addEventListener(ev, () => markRead(sid, key, b));
            }
        }
        if (i.at) {
            // the full date sits on the time itself, so it doesn't pop up over the whole card
            const t = el('span', 'b-time', shortTime(i.at));
            t.title = b.title;
            b.removeAttribute('title');
            row.append(t);
        }
        b.append(row);
    }
    if (i.role === 'assistant') {
        // a question's options stay out of the fold, under the TLDR
        // an older reply's Heads-up goes into its fold: the newest one says it
        const heads = i.headsUp && !look.latest ? `**Heads-up:** ${i.headsUp}\n\n` : '';
        const parts = foldable(i.tldr, heads + (i.options ? i.text.replace(i.options, '') : i.text), key);
        if (i.options) {
            const opts = rich(i.options);
            opts.classList.add('b-options');
            parts.splice(1, 0, opts);
        }
        if (i.headsUp && look.latest) {
            const heads = el('div', 'b-heads');
            heads.append(el('b', null, 'Heads-up: '), ...rich(i.headsUp, true).childNodes);
            parts.splice(1, 0, heads);
        }
        b.append(...parts);
    } else if (i.label) { // a button's message: the action on one line, what it typed behind it
        b.classList.add('canned');
        b.append(foldLine(el('div', 'body', i.label), rich(i.text), key));
    } else {
        const text = withoutImageLines(i.text);
        if (text || !imageNames(i.text).length) {
            const body = rich(text);
            if (!state.unfold.has(key)) {
                body.classList.add('fold');
            }
            b.append(body);
        }
        const names = imageNames(i.text);
        if (names.length) {
            const row = el('div', 'b-images');
            row.append(...names.map(bubbleImage));
            b.append(row);
        }
    }
    if (look.replies) {
        b.append(look.replies);
    }
    if (i.answer) {
        b.append(answerTag(i.answer));
    }
    if (i.interrupted) {
        b.append(tooltip(b, 'Interrupted by you'));
    }
    const note = noteRow(i, sid, key);
    if (note) {
        b.append(note);
    }
    b.dataset.key = key;

    return b;
}

// Under a user bubble: "Not sent" or "Not confirmed" (with Retry and Dismiss), "sending…" or "queued" (with Send now), else null.
/** @param {ChatItem | OutboxItem} i @param {string} sid @param {string} key */
function noteRow(i, sid, key) {

    const lost = ('unconfirmed' in i && i.unconfirmed) || (i.error && state.outbox.includes(/** @type {OutboxItem} */ (i))) ? /** @type {OutboxItem} */ (i) : null;
    const note = i.error ? `Not sent${'refused' in i && i.refused ? `: ${i.error}` : ''}` : lost ? 'Not confirmed — Claude may not have received this' : i.sending ? 'sending…' : i.pending ? 'queued' : null;
    if (!note) {
        return null;
    }

    const n = el('div', 'b-note', note);
    if (lost) {
        const drop = () => { state.outbox = state.outbox.filter(o => o !== lost); };
        const retry = waButton('Retry', 'retry', { pill: true }), dismiss = waButton('Dismiss', 'dismiss', { pill: true, appearance: 'plain' });
        retry.onclick = async e => {
            if (lost.unconfirmed) { // it may have arrived after all: look before sending a second copy
                retry.disabled = true;
                try {
                    if (await arrived(lost)) {
                        return refreshChat(); // which drops the bubble for the transcript's own
                    }
                } catch {
                    retry.disabled = false;
                    return showErr('Couldn’t check whether this arrived, so it was not sent again. Try Retry once Homebase answers.');
                }
            }
            drop();
            const ta = /** @type {WaTextarea} */ ($('msg'));
            if (ta.value === lost.text && (draftSid ?? startingTarget()) === lost.sid) { // a failed send gave the text back: sent from here, it must not wait for a second Enter
                ta.value = '';
                saveDraft(draftStorage(), lost.sid, ta);
            }
            focusComposer(e);
            sendText(lost.sid, lost.text, lost.answerTo, lost.note, lost.canned);
        };
        dismiss.onclick = e => {
            drop();
            focusComposer(e);
            refreshChat();
        };
        n.append(' ', ...(lost.refused ? [] : [retry]), dismiss); // a refusal (409) would only be refused again: its reason says what to do
    }
    if (i.pending && !i.sending) {
        const btn = waButton('Send now', 'send-now', { pill: true });
        btn.onclick = () => sendNow(sid, key);
        n.append(btn, tooltip(btn, "Interrupts Claude's current step so your message is handled now"));
    }

    return n;
}

// The user's short reply to this question, outside the fold so it shows when collapsed to the TLDR.
/** @param {Answer} a */
function answerTag(a) {
    const yes = !/^(no|nope)\b/i.test(a.text);
    const t = el('div', `answer${yes ? ' yes' : ''}${a.error ? ' failed' : ''}`);
    t.append(el('span', 'mark', a.error ? '!' : yes ? '✓' : '✕'), ` You: ${a.text}`);
    const note = a.error ? `Not sent: ${a.error}` : a.unconfirmed ? 'not confirmed — Claude may not have received this' : a.sending ? 'sending…' : a.queued ? 'queued' : null;
    if (note) {
        t.append(` · ${note}`);
    }
    return t;
}

// "Show more" only where the fold actually cuts something off; needs layout, so runs after insertion.
function addShowMore(feed) {
    for (const ran of /** @type {NodeListOf<HTMLElement>} */ (feed.querySelectorAll('.c-ran:not([hidden])'))) {
        /** @type {HTMLElement} */ (ran.parentElement.querySelector('.show')).hidden = ran.scrollWidth <= ran.clientWidth;
    }
    for (const body of feed.querySelectorAll('.body.fold')) {
        if (body.scrollHeight <= body.clientHeight + 4) {
            body.classList.remove('fold');
            continue;
        }
        const btn = el('button', 'show', 'Show more');
        btn.setAttribute('aria-expanded', 'false');
        btn.onclick = () => {
            const key = body.parentElement.dataset.key, folded = body.classList.toggle('fold');
            if (folded) {
                state.unfold.delete(key);
            } else {
                state.unfold.add(key);
            }
            btn.textContent = folded ? 'Show more' : 'Show less';
            btn.setAttribute('aria-expanded', String(!folded));
            body.parentElement.dispatchEvent(new Event('click')); // marks a needs-you bubble read
            if (!folded) {
                body.scrollIntoView({ block: 'nearest' }); // text taller than the pane starts at its top
            }
        };
        body.after(btn);
    }
}

// Text that is rewritten on every poll: an unchanged node is left alone, so a live region does not repeat itself.
/** @param {HTMLElement} node @param {string} text */
const setText = (node, text) => {
    if (node.textContent !== text) {
        node.textContent = text;
    }
};

// Screen readers hear a reply of the open chat once, when its turn ends: its topic, its TLDR (or first line) and whether
// it waits on the user. Not on opening a chat, and a question is announced by its card.
/** @type {{ sid: string, id?: string }} */
let heard = { sid: '' };
/** @param {Session} s @param {Transcript} data @param {ChatItem[]} items */
function announceReply(s, data, items) {
    const last = data.working || data.asking ? null : items.findLast(i => i.role === 'assistant'), id = last && `${last.id ?? last.at}:${last.text.length}`;
    if (last && heard.sid === s.id && heard.id !== id) {
        const say = (last.tldr || last.text.split('\n').find(l => l.trim()) || '').trim().slice(0, 220);
        $('announce').textContent = [`Claude replied${last.topic ? `, ${last.topic}` : ''}`, say, last.needsYou || last.waiting ? 'Needs you' : ''].filter(Boolean).join('. ');
    }
    heard = { sid: s.id, id: last ? id : heard.sid === s.id ? heard.id : undefined };
}

// Fixed-height line at the top of the composer, with the context window use on the right.
/** @param {Parameters<typeof chatStatus>[0]} data */
function setStatus(data) {
    const s = chatSession(), { kind, text } = chatStatus(data, Date.now(), s);
    if (!$('status').classList.contains(kind) && (kind === 'error' || kind === 'stuck')) {
        setText($('announce'), text); // the line itself is no live region: a working chat's step changes would be read out all day
    }
    $('status').className = `c-status ${kind}`;
    if ($('status-text').textContent === text) {
        // unchanged: not rewritten, so the nodes (and a focused "needs your answer" button) stay
    } else if (kind === 'idle' && text.startsWith(NEEDS_ANSWER)) {
        const go = el('button', 'show', NEEDS_ANSWER);
        go.type = 'button';
        go.onclick = jumpToNeeds;
        $('status-text').replaceChildren(go, text.slice(NEEDS_ANSWER.length));
    } else {
        $('status-text').textContent = text;
    }
    $('status-restart').hidden = kind !== 'stuck';
    $('status-ctx').className = `c-ctx ${ctxLevel(s?.context ?? 0)}`;
    const ctx = s?.context != null ? `${Math.round(s.context)}%` : '';
    if ($('status-ctx').textContent !== (ctx && `context ${ctx}`)) {
        $('status-ctx').replaceChildren(...(ctx ? [el('span', 'w', 'context '), ctx] : [])); // phones hide the word
    }
}

// Scrolls to and focuses what needs the user: the ask card when it shows, else the reply the pinned strip is about,
// else the newest needs-you bubble.
function jumpToNeeds() {

    const waiting = !$('wait').hidden && $('feed').querySelector(`[data-key="${CSS.escape($('wait').dataset.key ?? '')}"]`);
    const t = /** @type {HTMLElement | undefined} */ (!$('ask').hidden ? $('ask') : waiting || [...$('feed').querySelectorAll('.bubble.needs')].at(-1));
    if (!t) {
        return;
    }

    t.tabIndex = -1;
    t.scrollIntoView({ block: 'nearest' });
    t.focus({ preventScroll: true });
}

// same unwrap as the server's unwrapPasted, plus whitespace collapsed, for matching sent text to transcript text
const norm = t => (t || '').replace(/<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content(?: id="\1")?>/g, '$2').replace(/\s+/g, ' ').trim();
// "New session started in …" above the feed, for a newer master in the bound session's project.
/** @param {Session | null} s */
function showNewer(s) {

    const newer = newerSession(visibleSessions(), s);
    $('newer').hidden = !newer;
    if (newer) {
        setText($('newer-text'), `New session started in ${newer.project} · `);
        $('newer-go').onclick = () => bindChat(newer.id);
    }
}

// "Rules changed since this chat started" above the composer; Dismiss hides it until a watched file changes again.
/** @param {Session | null} s */
function showRules(s) {

    $('rules').hidden = !s?.rulesStale;
    if (!$('rules').hidden) {
        $('rules').title = `Changed: ${s.rulesStale.join(', ')}`;
        const dismiss = () => {
            // on the server, so every device agrees; hidden here at once, the next poll drops it everywhere
            api('/api/rules/seen', { method: 'POST', body: JSON.stringify({ id: s.id, at: s.rulesAt ?? 0 }) }).catch(() => {});
            s.rulesStale = undefined;
            showRules(s);
        };
        $('rules-dismiss').onclick = dismiss;
        // Claude re-reads the files itself: no restart, so running agents keep going
        $('rules-load').onclick = async () => {
            if (await sendText(s.id, s.rulesReload, undefined, undefined, true)) {
                dismiss();
            }
        };
    }
}

// The chat card's top strip (back, branch chips, Changes) and the project in the input's placeholder.
/** @param {Session | null} s */
function showHead(s) {

    $('c-back').hidden = !(s && s.id === state.focus);
    $('c-next').hidden = $('c-back').hidden || !nextId;
    const branch = $('c-branch'), un = $('c-unpushed');
    branch.hidden = !s?.branch;
    branch.textContent = branch.title = s?.branch ?? '';
    branch.classList.toggle('warn', /^(main|master)$/.test(s?.branch ?? '') && !s?.hobby);
    un.hidden = !(s?.unpushed > 0);
    un.textContent = `${s?.unpushed} unpushed`;
    showModel(s);
    syncDiff(s);
    $('msg').setAttribute('placeholder', s ? `Message Claude in ${s.project}…` : 'Message Claude…');
    $('msg').setAttribute('label', s ? `Message Claude in ${s.project}` : 'Message Claude');
}

/** @type {{ sid: string, name: string, at: number } | null} */
let pickedModel = null; // a /model sent, until the transcript shows that model (or MODEL_PENDING_MS passed)
const MODEL_PENDING_MS = 60_000;

// The model chip: the model of the chat's latest reply; "Sonnet…" while a picked one hasn't shown up there yet.
/** @param {Session | null} s */
function showModel(s) {

    const name = modelName(s?.model);
    if (pickedModel && (pickedModel.sid !== s?.id || name === pickedModel.name || Date.now() - pickedModel.at > MODEL_PENDING_MS)) {
        pickedModel = null;
    }

    const btn = $('c-model-btn');
    $('c-model').hidden = !s || s.id.startsWith('cc-new-') || !(name || pickedModel);
    setText(btn, pickedModel ? `${pickedModel.name}…` : `${name ?? ''} ▾`);
    btn.classList.toggle('pending', !!pickedModel);
    for (const it of /** @type {NodeListOf<HTMLElement & { value: string, checked: boolean }>} */ ($('c-model').querySelectorAll('wa-dropdown-item'))) {
        it.checked = modelName(it.value) === (pickedModel?.name ?? name); // from our state, not the item's own toggle
    }
}

// Above a focused (not main) chat's question: what it is about, its title and linked MR, then its last reply's TLDR.
/** @param {Session} s @param {ChatItem[]} items */
function showFocus(s, items) {

    const box = $('c-focus'), on = s.id === state.focus;
    box.hidden = !on;
    if (!on) {
        return;
    }

    const x = state.sessions.flatMap(o => o.items || []).find(i => i.sessionId === s.id && i.pr);
    const last = items.findLast(i => i.role === 'assistant' && !i.error);
    const say = last && (last.tldr || last.text.split('\n').find(l => l.trim()) || '').trim().slice(0, 220);
    box.replaceChildren(el('b', null, [s.title || s.topic, x && `${x.title} (${x.pr.split('/').pop()})`].filter(Boolean).join(' · ') || s.project), ...(say ? [el('div', null, say)] : []));
}

const DETAIL_LINES = 6;

// The ask and startup cards: the question, an option per button (its description under it) that `answer` picks, else
// read-only rows; and the tmux command to answer in the terminal. The ask card also shows a permission prompt's command
// or diff (`detail`, its first lines and "+N more lines"), in red when the server flags it risky.
/** @param {string} id @param {string} tmux @param {string} question @param {{ label: string, desc?: string, primary?: boolean, quiet?: boolean }[]} options @param {((i: number) => Promise<void>) | null} answer @param {{ detail?: string, risky?: boolean }} [prompt] */
function fillCard(id, tmux, question, options, answer, { detail = '', risky = false } = {}) {

    $(`${id}-q`).textContent = question;
    $(`${id}-cmd`).textContent = `tmux attach -t ${tmux}`;
    if (id === 'ask') {
        // the terminal command is only the way out when there are no buttons; otherwise behind a toggle
        const toggle = $('ask-term-toggle'), term = $('ask-term');
        toggle.hidden = !answer;
        term.hidden = !!answer;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.onclick = () => {
            term.hidden = !term.hidden;
            toggle.setAttribute('aria-expanded', String(!term.hidden));
        };
        setText($('announce'), `Claude is asking: ${question}`);

        const pre = $('ask-detail'), more = $('ask-more'), lines = detail ? detail.split('\n') : [], rest = lines.length - DETAIL_LINES;
        pre.hidden = !detail;
        pre.textContent = lines.slice(0, DETAIL_LINES).join('\n');
        more.hidden = rest <= 0;
        more.textContent = `+${rest} more line${rest === 1 ? '' : 's'}`;
        more.onclick = () => {
            pre.textContent = detail;
            more.hidden = true;
        };
        $('ask').classList.toggle('risky', risky);
    }
    $(`${id}-opts`).replaceChildren(...options.map((o, i) => {
        const b = optButton(o.label, i, { desc: o.desc, ro: !answer, quiet: o.quiet });
        if (answer) {
            b.onclick = async e => {
                focusComposer(e);
                $('c-err').textContent = '';
                for (const x of $(`${id}-opts`).children) {
                    x.setAttribute('disabled', '');
                }
                b.setAttribute('loading', '');
                await answer(i).catch(err => { showErr(err.message); });
            };
        }

        return b;
    }));
}

// The red error line, with raw server and tmux errors turned into plain sentences.
/** @param {string} msg */
const showErr = msg => { $('c-err').textContent = friendly(msg); };

// POSTs an answer; a refusal's text is the error.
/** @param {string} url */
const postAnswer = async url => {
    const r = await api(url, { method: 'POST' });
    if (!r.ok) {
        throw new Error(await r.text());
    }
};

const TEXT_BOX = /^type something\.?$/i; // Claude's own text-box entry under a question: the chat input below covers it
const CHAT = /^chat about this$/i; // declines the question as "the user wants to clarify"; Claude then asks what about
const GRANT = /^yes, .*(?:don't ask again|auto mode|accept edits)/i; // a permission option that also approves what comes later
let askKey = null;
let answeredAsk = null; // data.asking of the question last answered on the pane, until the transcript stops asking it
// The chat whose pane may show a dialog its transcript doesn't ask (Claude's "Switch model?" after a /model pick): set by
// a pick and by a send refused for it, so the card shows it; cleared once the pane shows none.
/** @type {string | null} */
let paneCheck = null;

// The "Claude is asking" card. The question on the tmux pane gets buttons (the server moves the ❯ there and confirms,
// one question at a time); descriptions come from the transcript, else the pane. No question readable there: the transcript's, see below.
/** @param {Session} s @param {Transcript} data */
async function showAsk(s, data) {

    state.asking = data.asking;
    $('c-model-btn').toggleAttribute('disabled', !!data.asking); // /model goes through send, whose Esc would decline the question
    updateTitle();
    const hide = () => {
        $('ask').hidden = true;
        askKey = null;
    };
    if (!data.asking) {
        setFormatWarn('pane', false);
        answeredAsk = null;
        if (paneCheck !== s.id) {
            return hide();
        }
    }

    const tmux = s.tmux ?? `cc-${s.id.slice(0, 8)}`;
    /** @type {{ question: string, options: string[], descriptions: string[], selected: number, detail?: string, risky?: boolean } | null} */
    let pane = null;
    try {
        const r = await api(`/api/question?tmux=${encodeURIComponent(tmux)}`);
        pane = r.ok ? (await r.json()).question : null;
    } catch {}
    if (!data.asking && !pane) {
        paneCheck = pickedModel?.sid === s.id ? paneCheck : null; // a pending pick: its dialog may still be drawing
        return hide();
    }
    setFormatWarn('pane', !pane && data.asking !== answeredAsk); // the transcript asks but the screen shows no question we can parse
    const key = JSON.stringify([tmux, data.questions, data.asking, pane && [pane.question, pane.detail, pane.options, pane.descriptions]]); // not the moving ❯
    if (key === askKey) {
        return;
    }
    askKey = key;
    $('ask').hidden = false; // shown once filled, never empty
    $('ask-dismiss').onclick = async () => {
        $('ask').hidden = true; // Esc in the chat; the transcript then shows the question declined
        try {
            await postAnswer(`/api/question?tmux=${encodeURIComponent(tmux)}&dismiss=1`);
        } catch (err) {
            $('ask').hidden = false;
            showErr(err.message);
        } finally {
            askKey = null;
        }
    };

    const questions = data.questions?.length ? data.questions : data.asking ? [{ question: data.asking, options: [] }] : [];
    if (!pane && data.asking === answeredAsk) {
        $('ask').hidden = true; // answered, the transcript just hasn't caught up: never re-show its options
        return;
    }
    if (!pane) {
        // no question readable on the pane (not in tmux, or a screen this can't parse): one question's options still answer by
        // click, typed as a message naming the question (the server declines the dialog first); several stay read-only
        const one = questions.length === 1 && questions[0].options.length ? questions[0] : null;
        fillCard('ask', tmux, questions.map(q => q.question).join(' · '), questions.flatMap(q => q.options.map((label, i) => ({ label, desc: q.descriptions?.[i] }))), one && (async n => {
            if (await sendText(s.id, one.options[n], undefined, `(Answering your question: "${one.question}")`)) {
                answeredAsk = data.asking;
            }
            askKey = null;
            refreshChat();
        }));
        return;
    }
    const flat = t => t.replace(/\s+/g, ' ').trim();
    const known = questions.find(q => flat(q.question).endsWith(pane.question)); // a question taller than the pane shows only its end
    const options = pane.options.map((label, i) => ({ i, label, desc: known?.descriptions?.[known.options.indexOf(label)] || pane.descriptions[i], primary: /\(recommended\)/i.test(label), quiet: CHAT.test(label) || GRANT.test(label) }))
        .filter(o => !TEXT_BOX.test(o.label))
        .sort((a, b) => Number(a.quiet) - Number(b.quiet)); // quiet ones last: Yes and No stay the big pair
    // not on a dialog that isn't the transcript's question ("Switch model?"): Esc there declines nothing
    if (data.questions?.length && (known || /^Review your answers/.test(pane.question)) && !options.some(o => CHAT.test(o.label))) {
        options.push({ i: -1, label: 'Chat about this', desc: '', primary: false, quiet: true }); // no such entry on the pane: Esc declines instead
    }
    fillCard('ask', tmux, known?.question ?? pane.question, options, async n => {
        try {
            await postAnswer(`/api/question?tmux=${encodeURIComponent(tmux)}&${options[n].i < 0 ? 'dismiss=1' : `option=${options[n].i}&label=${encodeURIComponent(options[n].label)}&seen=${seenHash(pane)}`}`);
            answeredAsk = data.asking;
            answered(s.id);
            if (CHAT.test(options[n].label)) {
                $('msg').focus(); // the user's turn to say what they want instead
            }
        } finally {
            askKey = null;
            refreshChat(); // fresh transcript: the pane shows the next question or none, and `data` still has the answered one
        }
    }, pane);
}

// A blocking Claude Code startup dialog (workspace trust, first run) read off the tmux pane: its question, an option per button.
// Clicking one has the server move the ❯ selection there and confirm; while it is up, normal sends are blocked.
/** @param {string | null | undefined} tmux */
async function showBoot(tmux) {

    let dialog = null;
    try {
        const r = tmux && await api(`/api/startup?tmux=${encodeURIComponent(tmux)}`);
        dialog = r && r.ok ? (await r.json()).dialog : null;
    } catch {}
    if (state.boot !== undefined && JSON.stringify(dialog) === JSON.stringify(state.boot)) { // undefined: re-render
        return;
    }
    state.boot = dialog;
    $('boot').hidden = !dialog;
    if (dialog) {
        fillCard('boot', tmux, dialog.question, dialog.options.map(label => ({ label })), async i => {
            try {
                await postAnswer(`/api/startup?tmux=${encodeURIComponent(tmux)}&option=${i}&label=${encodeURIComponent(dialog.options[i])}`);
            } finally {
                state.boot = undefined;
                showBoot(tmux);
            }
        });
    }
}

const LANDED_SLACK_MS = 10_000; // a transcript item may predate the send it matches by this much
const OUTBOX_TTL_MS = 30_000; // after a successful send, a bubble nothing matched by then is marked not confirmed

// Whether the transcript's items hold what an outbox item sent (see feedItems).
/** @param {ChatItem[]} items @param {OutboxItem} o */
function landedIn(items, o) {
    const sameSend = (text, at) => [o.text, o.note && `${o.text}\n\n${o.note}`].some(t => t && norm(text) === norm(t)) && !(Date.parse(at) < Date.parse(o.at) - LANDED_SLACK_MS);
    return items.some(i => (i.role === 'user' && sameSend(i.text, i.at))
        || (i.role === 'command' && sameSend(i.cmd, i.at)) // a slash command whose output the transcript now holds
        || (i.answer && sameSend(i.answer.text, i.answer.at)));
}
// The same, read fresh from the server: before Retry sends a not confirmed message again. Throws when it can't be read.
/** @param {OutboxItem} o */
async function arrived(o) {
    const s = state.sessions.find(x => x.id === o.sid);
    if (!s) {
        return false; // a chat still starting has no transcript to ask
    }
    const r = await api(`/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}`);
    if (!r.ok) {
        throw new Error(await r.text());
    }
    return landedIn((await r.json()).items, o);
}

// The transcript's items merged with this session's outbox, minus what Clear view hides; prunes state.outbox and
// state.nudged on the way. hidden: how many items the cut-off removed from the front.
/** @param {Session} s @param {Transcript} data @returns {{ items: ChatItem[], hidden: number, cut: { at: number, fresh: boolean } }} */
function feedItems(s, data) {

    // Optimistic bubbles go once any user/queued/pending item (or answer) has the same text, sent no earlier than
    // LANDED_SLACK_MS before: the transcript is the source of truth. OUTBOX_TTL_MS after the send succeeded with no
    // match, it stays marked not confirmed (Retry / Dismiss) rather than vanishing.
    // (compared with what was sent: the text, or the text plus its unshown note, as the transcript has the two together)
    state.outbox = state.outbox.filter(o => o.sid !== s.id || o.error || !landedIn(data.items, o));
    // a slash command with no output in the transcript never shows there: once sent it stays, with its result; so does an
    // answer typed into a question's text box, unless the transcript shows it as that question's answer
    for (const o of state.outbox) {
        o.unconfirmed ||= o.sid === s.id && !o.text.startsWith('/') && !o.answered && Date.now() - o.okAt > OUTBOX_TTL_MS;
    }

    // a queued item whose Send now was clicked shows "sending…" until the queue entry resolves
    state.nudged = new Set(data.items.filter(i => i.pending).map(i => `${s.id}:${i.at}`).filter(k => state.nudged.has(k)));
    /** @type {ChatItem[]} */
    const items = data.items.map(i => (i.pending && state.nudged.has(`${s.id}:${i.at}`) ? { ...i, sending: true } : i));

    // placed by send time, so one sent before a queued message stays above it
    for (const o of state.outbox.filter(o => o.sid === s.id)) {
        // a chip answer shows as the question's tag, not a bubble
        const q = o.answerTo && items.findIndex(x => x.role === 'assistant' && x.at === o.answerTo);
        if (q >= 0) {
            if (!items[q].answer) {
                items[q] = { ...items[q], answer: { text: o.text, sending: !o.error && !o.unconfirmed, error: o.error, unconfirmed: o.unconfirmed } };
            }
            continue;
        }
        const i = items.findIndex(x => Date.parse(x.at) > Date.parse(o.at));
        const r = o.result;
        const hint = r?.stuck ?? (r?.pick ? 'Pick this in the terminal, or type the command with its argument (e.g. /model opus)' : undefined);
        // a slash command that went through is its command line; one still sending or not sent keeps its bubble (Retry)
        const ran = r || (o.text.startsWith('/') && !o.sending && !o.error);
        items.splice(i < 0 ? items.length : i, 0, ...(ran ? [{ role: /** @type {const} */ ('command'), text: r?.text ?? '', cmd: o.text, at: o.at, hint }] : [o]));
    }

    // Clear view: items up to the stored cut-off stay hidden in Homebase only
    const cut = clearState(store.get(`cleared:${s.id}`));
    const hidden = items.findLastIndex(i => i.at && Date.parse(i.at) <= cut.at) + 1;
    // not the question that still waits for an answer (a decision, or reply chips nothing came after), nor a message that is not confirmed sent
    const open = openDecision({ items }), n = items.findLastIndex(i => i.replies?.length && !i.answer);
    const asks = n >= 0 && !items.slice(n + 1).some(x => x.role === 'user') ? items[n] : null;
    items.unshift(...items.splice(0, hidden).filter(i => i === open || i === asks || state.outbox.includes(/** @type {OutboxItem} */ (i))));

    return { items, hidden, cut };
}

const EXCERPT_CHARS = 150;

// What an older question asked, for the note that tells Claude which one a chip answers: its TLDR, else its last paragraph.
/** @param {ChatItem} i */
function questionExcerpt(i) {

    const ask = i.tldr?.trim().endsWith('?') ? i.tldr : (i.text ?? '').trim().split(/\n\s*\n/).at(-1);
    const flat = (ask ?? '').replace(/[*_`"]/g, '').replace(/\s+/g, ' ').trim();

    return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

// What a chip on items[n] sends after its label: nothing for the newest item, else a note naming the question it answers.
/** @param {ChatItem[]} items @param {number} n */
const answerNote = (items, n) => (n === items.length - 1 ? undefined : `(Answering your earlier question from ${items[n].at}: "${questionExcerpt(items[n])}")`);

// The amber strip pinned above the composer while Claude's newest reply says something waits on the user, also after
// the user said something else: that text (a click jumps to the reply) and its chips. The ask card takes its place.
let waitKey = null;
/** @param {Session | null} s @param {Transcript | null} data @param {ChatItem[]} items */
function showWait(s, data, items) {

    const w = s && data && !data.asking ? openDecision({ items }) : null, key = w && JSON.stringify([s.id, w.at, w.waiting, w.replies]);
    $('wait').hidden = !w;
    if (!w || key === waitKey) {
        waitKey = key;
        return;
    }

    waitKey = key;
    $('wait').dataset.key = `${s.id}:${w.at}`;
    // "issue — what led here — question — (1) … (2) …": the question on top, the rest muted and clamped, the options as chips
    $('wait-q').replaceChildren(...rich(w.ask?.question ?? w.waiting, true).childNodes);
    $('wait-q').onclick = jumpToNeeds;
    const ctx = $('wait-ctx');
    ctx.hidden = !w.ask?.context;
    ctx.replaceChildren(...rich(w.ask?.context ?? '', true).childNodes);
    ctx.classList.add('clamp');
    ctx.onclick = () => ctx.classList.toggle('clamp');
    const n = items.indexOf(w);
    const opts = w.ask?.options ?? (w.replies ?? []).map(label => ({ label, desc: '' }));
    $('wait-opts').replaceChildren(...opts.map(({ label, desc }, k) => {
        const b = optButton(label, k, { desc });
        b.onclick = e => {
            focusComposer(e);
            sendChip(b, s.id, label, w.at, answerNote(items, n));
        };

        return b;
    }));
}

// Quick replies under a Claude message that ends with a question and has no answer yet. The newest one waits for Claude
// to finish; an older one stays (the send just queues) and its chips carry a note naming the question; a message
// the user sent after it hides them.
/** @param {Session} s @param {Transcript} data @param {ChatItem[]} items @param {number} n */
function quickReplyRow(s, data, items, n) {

    const q = items[n], newest = n === items.length - 1;
    if (q === openDecision({ items }) && !data.asking) {
        return null; // the strip above the composer has its chips
    }
    if (!(q.replies?.length && (!q.answer || q.answer.error || q.answer.unconfirmed) && !data.asking && (newest || !items.slice(n + 1).some(x => x.role === 'user')) && !(newest && data.working))) {
        return null;
    }

    const note = answerNote(items, n);
    const row = el('div', 'replies');
    row.append(...q.replies.map((t, i) => {
        const b = optButton(t, i);
        b.onclick = e => {
            focusComposer(e);
            sendChip(b, s.id, t, q.at, note);
        };

        return b;
    }));

    return row;
}

// A chip tap sends its answer; the row's chips stay disabled (as the ask card's do) so a double tap sends once. Sent, the
// row is replaced once the answer shows; a failed send enables them again.
/** @param {HTMLElement} b @param {string} sid @param {string} text @param {string} answerTo @param {string} note */
async function sendChip(b, sid, text, answerTo, note) {

    if (b.hasAttribute('disabled')) {
        return;
    }
    const row = [...b.parentElement.children];
    row.forEach(x => x.setAttribute('disabled', ''));
    b.setAttribute('loading', '');

    if (!await sendText(sid, text, answerTo, note)) {
        row.forEach(x => x.removeAttribute('disabled'));
        b.removeAttribute('loading');
    }
}

const NEAR_BOTTOM_PX = 40; // this close to the bottom counts as reading the newest: a re-render keeps it in view
/** @param {HTMLElement} feed */
const nearBottom = feed => feed.scrollHeight - feed.scrollTop - feed.clientHeight < NEAR_BOTTOM_PX;
/** @param {HTMLElement} feed @returns {HTMLElement[]} */
const keyed = feed => /** @type {HTMLElement[]} */ ([...feed.querySelectorAll('[data-key]')]);

// Where the reader is: at the newest (end), or with the first visible bubble (key) y px below the feed's top. Taken
// only when the feed's offset differs from the one last taken or set (top), i.e. when the user scrolled, and after a
// click in the feed (Show more). Content that changes height by itself (a re-render, a thumbnail loading, a button
// upgrading, the composer resizing the feed) is not the reader moving: watchSizes sees it and restorePlace puts them back.
/** @type {{ end: boolean, top: number, key?: string, y: number }} */
let place = { end: true, top: 0, y: 0 };
/** @param {HTMLElement} feed */
function notePlace(feed) {
    const feedTop = feed.getBoundingClientRect().top;
    // the window drops old items off the top, so the bubble is the anchor, not the scroll offset
    const b = keyed(feed).find(b => b.getBoundingClientRect().bottom > feedTop + 5);
    place = { end: nearBottom(feed), top: feed.scrollTop, key: b?.dataset.key, y: b ? b.getBoundingClientRect().top - feedTop : 0 };
}
// True when the user scrolled since the place was taken; takes the new one.
/** @param {HTMLElement} feed */
function syncPlace(feed) {
    const moved = feed.scrollTop !== place.top;
    if (moved) {
        notePlace(feed);
    }
    return moved;
}
/** @param {HTMLElement} feed */
function restorePlace(feed) {
    if (place.end) {
        feed.scrollTop = feed.scrollHeight;
    } else {
        feed.scrollTop = place.top;
        const b = place.key && keyed(feed).find(b => b.dataset.key === place.key);
        if (b) {
            feed.scrollTop += b.getBoundingClientRect().top - feed.getBoundingClientRect().top - place.y;
        }
    }
    place.top = feed.scrollTop;
}
/** @type {ResizeObserver | undefined} */
let sizes;
let clicked = false; // a click in the feed is being handled: a size change now is the reader's own (Show more)
// Watches the feed and every item in it for a change of size, whatever the cause; called after each redraw.
/** @param {HTMLElement} feed */
function watchSizes(feed) {
    sizes ??= new ResizeObserver(() => {
        if (clicked) {
            return notePlace(feed);
        }
        syncPlace(feed);
        restorePlace(feed);
    });
    sizes.disconnect();
    for (const e of [feed, ...feed.children]) {
        sizes.observe(e);
    }
}

let refreshSeq = 0; // a refresh that finishes after a newer one started is stale: it must not render over it

export async function refreshChat() {

    const seq = ++refreshSeq;
    followFocus();
    const s = chatSession(), feed = $('feed');
    swapComposer(s?.id ?? null);
    // persist the binding, or a successor it moved to
    if (s && !state.focus && store.get(bindKey()) !== s.id) {
        store.set(bindKey(), s.id);
        renderBoard();
    }
    showNewer(state.focus ? null : s);
    showHead(s);
    showRules(s);
    await showBoot(s ? null : state.startingTmux); // only a chat still starting: a running one's ❯ prompts and questions aren't startup dialogs
    if (!s) {
        $('compact-item').disabled = true;
        $('compact-nudge').hidden = true;
        chatKey = null;
        state.asking = null;
        showWait(null, null, []);
        updateTitle();
        setStatus(state.offline ? { error: true } : null);
        // a message sent to a starting project (by tmux name) shows until its session binds
        const sent = state.outbox.filter(o => o.sid === startingTarget());
        return feed.replaceChildren(...(sent.length ? sent.map(o => bubble(o, o.sid, null)) : [el('div', 'welcome', state.starting ? 'Chat starting…' : 'No session to chat with yet. Use ☰ → Open existing folder… to start one in a project, or ☰ → New project.')]));
    }

    /** @type {Transcript} */
    let data;
    if (feedMax.sid !== s.id) {
        feedMax = { sid: s.id, max: FEED_STEP };
    }
    try {
        const r = await api(`/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}&max=${feedMax.max}`);
        if (!r.ok) {
            throw Object.assign(new Error(await r.text()), { status: r.status });
        }
        data = await r.json();
    } catch (e) {
        setOffline(true, e.status);
        return setStatus({ error: true });
    }
    if (chatSession()?.id !== s.id || seq !== refreshSeq) {
        return; // switched while loading, or a newer refresh took over
    }

    setStatus(data);
    await showAsk(s, data);
    if (seq !== refreshSeq) {
        return;
    }
    compactUi(s, data);

    const { items, hidden, cut } = feedItems(s, data);
    announceReply(s, data, items);
    showWait(s, data, items);
    showFocus(s, items);
    const fresh = cut.fresh || !!s.clearedFrom; // a New conversation, before or after the successor is bound
    const lastSeen = Number(store.get(`last-seen:${s.id}`)) || Infinity;
    const key = s.id + JSON.stringify([items, data.asking, data.working, hidden, data.more, data.capped, lastSeen]);
    if (key === chatKey) {
        return focusWanted(s.id);
    }

    const first = !chatKey?.startsWith(s.id);
    syncPlace(feed);
    chatKey = key;

    let seen = seenStore(s.id);
    if (!seen) {
        seen = { at: Date.parse(items.at(-1)?.at) || Date.now(), keys: [] };
        store.set(`needs-seen:${s.id}`, JSON.stringify(seen));
    }
    // unread: newer than the first load, not opened, and no message from the user after it
    const unread = /** @param {ChatItem} i @param {number} n */ (i, n) => i.needsYou
        && Date.parse(i.at) > seen.at
        && !seen.keys.includes(`${s.id}:${i.at}`)
        && !items.slice(n + 1).some(x => x.role === 'user');
    const latest = items.findLastIndex(i => i.role === 'assistant');
    const before = new Set(keyed(feed).map(b => b.dataset.key));
    const firstNew = items.findIndex(i => Date.parse(i.at) > lastSeen);
    let topic = null;
    feed.replaceChildren(...items.flatMap((i, n) => {
        const prev = topic;
        if (i.role === 'assistant') {
            topic = i.topic;
        }

        const run = i.role === 'command' ? commandRun(items, n) : null;
        if (run && run.length !== 1) { // commands in a row: one line where the run starts
            return run.length ? [commandLine(run, s.id)] : [];
        }
        let b;
        try {
            b = bubble(i, s.id, prev, { latest: n === latest, unread: unread(i, n), replies: quickReplyRow(s, data, items, n) });
        } catch (e) { // one item that can't be drawn shows as its plain text; the rest of the feed stays
            console.error(e);
            b = el('div', `bubble ${i.role}`, typeof i.text === 'string' ? i.text : JSON.stringify(i.text ?? ''));
        }
        // only a bubble new since the last render rises in; a re-render redraws them all
        if (!first && b.dataset.key && !before.has(b.dataset.key)) {
            b.classList.add('enter');
        }

        return n === firstNew ? [el('div', 'tools compact c-new', 'New'), b] : [b];
    }));

    if (hidden && !cut.fresh) {
        const line = el('div', 'c-hidden', 'Earlier messages hidden · '), btn = el('button', 'show', 'Show');
        btn.onclick = () => {
            store.set(`cleared:${s.id}`, '');
            refreshChat();
        };
        line.append(btn);
        feed.prepend(line);
    } else if (data.more && !hidden) {
        const line = el('div', 'c-hidden c-earlier', 'Earlier messages not shown · '), btn = el('button', 'show', 'Show earlier');
        btn.onclick = () => {
            feedMax.max += FEED_STEP;
            keepFromBottom = feed.scrollHeight - feed.scrollTop;
            refreshChat();
        };
        line.append(btn);
        feed.prepend(line);
    } else if (data.capped && !hidden) { // the server reads no further back: say so, rather than end as if this were the start
        feed.prepend(el('div', 'c-hidden c-capped', 'Older messages are not shown here — the terminal has the whole chat'));
    } else if (!items.length) {
        feed.append(el('div', 'welcome', fresh ? 'New conversation — say something to Claude' : 'No messages yet. Send one below, or run `claude` in a terminal in this project.'));
    }

    addShowMore(feed);
    if (keepFromBottom !== null) {
        feed.scrollTop = feed.scrollHeight - keepFromBottom;
        notePlace(feed);
    } else {
        place.end ||= first || stick;
        restorePlace(feed);
    }
    watchSizes(feed);
    stick = false;
    keepFromBottom = null;
    focusWanted(s.id);
}

// "New since you looked": leaving the window marks the time per session (kept while an older mark is unread, i.e. the
// feed is scrolled up); the feed draws a New divider above the first later item, gone once you're back and scroll to the bottom.
function initNewMarker() {

    const feed = $('feed');
    watchSizes(feed);
    // Show more grew a bubble: the reader stays on it, not at the end. Capture, as the button stops the click; the
    // place is taken once it has toggled, by the timeout or by watchSizes, whichever the browser runs first.
    feed.addEventListener('click', () => {
        clicked = true;
        setTimeout(() => {
            clicked = false;
            notePlace(feed);
        });
    }, true);
    const bottom = () => nearBottom(feed);
    const leave = () => {
        const s = chatSession();
        if (s && (!store.get(`last-seen:${s.id}`) || bottom())) {
            store.set(`last-seen:${s.id}`, String(Date.now()));
        }
        away = true;
    };

    window.addEventListener('blur', leave);
    window.addEventListener('focus', () => { away = false; });
    document.addEventListener('visibilitychange', () => (document.hidden ? leave() : (away = false)));
    feed.addEventListener('scroll', () => {
        const s = chatSession();
        if (syncPlace(feed) && !away && s && store.get(`last-seen:${s.id}`) && bottom()) {
            store.set(`last-seen:${s.id}`, '');
            refreshChat();
        }
    });
}

/** @param {string} sid @param {string} key */
async function sendNow(sid, key) {
    state.nudged.add(key);
    $('c-err').textContent = '';
    refreshChat();
    try {
        const r = await api(`/api/interrupt?id=${encodeURIComponent(sid)}`, { method: 'POST' });
        if (!r.ok) {
            throw new Error(await r.text());
        }
    } catch (err) {
        state.nudged.delete(key);
        showErr(err.message);
        refreshChat();
    }
}

// The menu item and the "Compact?" nudge follow the bound session; the auto mode piggybacks on the same poll.
/** @param {Session} s @param {Transcript} data */
function compactUi(s, data) {

    const idle = canCompact(s) && !data.working && !data.asking;
    $('compact-item').disabled = !idle;
    $('compact-nudge').hidden = !(idle && compactNudgeDue(s));
    if (idle && store.get('auto-compact') !== '0') {
        const key = `auto-compacted:${s.id}`, now = Date.now();
        if (autoCompactDue(s, now, Number(store.get(key)) || 0)) {
            store.set(key, String(now)); // before the POST, so a slow or failed one is not retried within the hour
            compact(s.id);
        }
    }
}

/** @param {string} sid */
async function compact(sid) {
    $('c-err').textContent = '';
    try {
        const r = await api(`/api/compact?id=${encodeURIComponent(sid)}`, { method: 'POST' });
        if (!r.ok) {
            throw new Error(await r.text());
        }
        setTimeout(refreshChat, 1000);
    } catch (err) {
        showErr(err.message);
    }
}

/** @param {string} sid */
async function restart(sid) {
    $('c-err').textContent = '';
    $('c-info').textContent = 'Restarting Claude…';
    try {
        const r = await api(`/api/restart?id=${encodeURIComponent(sid)}`, { method: 'POST' });
        if (!r.ok) {
            throw new Error(await r.text());
        }
    } catch (err) {
        showErr(err.message);
    }
    $('c-info').textContent = '';
    refreshChat();
}

// Images attached to the next message. Sent as "[Image: <path>]" lines after uploading; Claude reads them by path.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** @type {File[]} */
let attached = [];
let uploading = false;
// Upload names in a message's "[Image: …]" lines (only the names /api/upload makes).
/** @param {string} text @returns {string[]} */
const IMAGE_LINE = /^\[Image: \/[^\]\n]*\/([0-9a-f-]{36}\.(?:png|jpe?g|gif|webp))\]$/gm;
const imageNames = text => [...(text || '').matchAll(IMAGE_LINE)].map(m => m[1]);
// The text without those lines: the bubble shows the pictures instead of their paths.
/** @param {string} text */
const withoutImageLines = text => (text || '').replace(IMAGE_LINE, '').replace(/\n{3,}/g, '\n\n').trim();

// data: URLs, as the CSP allows no blob: images. /api/upload/<name> needs the token header, so no plain <img src>.
/** @param {Blob} blob @returns {Promise<string>} */
const dataUrl = blob => new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(blob);
});
// ponytail: every image the chat showed stays in memory until reload; fine for a session's worth of screenshots
/** @type {Map<string, Promise<string>>} */
const images = new Map();
/** @param {string} name */
function imageUrl(name) {
    if (!images.has(name)) {
        images.set(name, api(`/api/upload/${name}`).then(r => (r.ok ? r.blob().then(dataUrl) : '')).catch(() => ''));
    }
    return /** @type {Promise<string>} */ (images.get(name));
}
/** @param {Promise<string>} url @param {string} alt */
function thumb(url, alt) {
    const img = el('img');
    img.alt = alt;
    url.then(u => { if (u) { img.src = u; } else { img.remove(); } });
    return img;
}
// A bubble's thumbnail: once loaded, the same element on every redraw of the feed, as a new <img> has no height until
// it has decoded and everything below it would jump on each redraw.
// ponytail: one element per upload, so a second bubble naming the same image would take it from the first
/** @type {Map<string, HTMLImageElement>} */
const shown = new Map();
/** @param {string} name */
function bubbleImage(name) {
    const img = shown.get(name) ?? zoomable(thumb(imageUrl(name), name));
    img.onload = () => shown.set(name, img);
    return img;
}
// Click a bubble thumbnail: the full image over the page; click or Escape closes it.
/** @param {HTMLImageElement} img */
function zoomable(img) {
    img.onclick = () => {
        const box = el('div', 'lightbox'), full = el('img');
        full.src = img.src;
        full.alt = img.alt;
        const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
        /** @param {KeyboardEvent} e */
        const onKey = e => { if (e.key === 'Escape') { close(); } };
        box.onclick = close;
        document.addEventListener('keydown', onKey);
        box.append(full);
        document.body.append(box);
    };
    return img;
}

/** @param {Iterable<File>} files */
function attach(files) {
    const list = [...files];
    const ok = list.filter(f => IMAGE_TYPES.includes(f.type));
    if (ok.length < list.length) {
        $('c-err').textContent = 'Only PNG, JPEG, GIF or WebP images can be attached';
    }
    attached = [...attached, ...ok];
    showAttached();
}
function showAttached() {
    $('attached').replaceChildren(...attached.map(f => {
        const t = el('span', 'c-thumb'), x = el('button', '', '×');
        x.type = 'button';
        x.ariaLabel = `Remove ${f.name}`;
        x.onclick = () => {
            attached = attached.filter(a => a !== f);
            showAttached();
        };
        t.append(thumb(dataUrl(f), f.name), x);
        return t;
    }));
    $('attached').hidden = !attached.length;
}
// Uploads the attached images; their "[Image: <path>]" lines, one per image.
/** @param {File[]} files @returns {Promise<string[]>} */
async function upload(files) {
    return Promise.all(files.map(async f => {
        const r = await api('/api/upload', { method: 'POST', headers: { 'content-type': f.type }, body: f });
        if (!r.ok) {
            throw new Error(`${f.name}: ${await r.text()}`);
        }
        return `[Image: ${(await r.json()).path}]`;
    }));
}

// Types text into a session as an outbox bubble ("sending…", then gone once the transcript has it); false if it failed.
// note: appended to what is sent but not shown, so the chat shows just the label.
// canned: a button's message, not typed by the user: the server refuses it while Claude asks, instead of declining the question.
/** @param {string} sid @param {string} text @param {string} [answerTo] @param {string} [note] @param {boolean} [canned] @returns {Promise<boolean>} */
export async function sendText(sid, text, answerTo, note, canned) {
    $('c-err').textContent = '';
    /** @type {OutboxItem} */
    const out = { role: 'user', text, sid, at: new Date().toISOString(), sending: true, answerTo, note, canned, ...(canned && { label: cannedLabel(text) ?? undefined }) };
    state.outbox = [...state.outbox.filter(o => !(o.error && o.sid === sid) && !(answerTo && o.answerTo === answerTo)), out];
    stick = true;
    refreshChat();
    try {
        const r = await api(`/api/send?${sid.startsWith('cc-new-') ? 'tmux' : 'id'}=${encodeURIComponent(sid)}${canned ? '&canned=1' : ''}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: note ? `${text}\n\n${note}` : text, signal: AbortSignal.timeout(45_000) }); // past control.mjs BOOT_MS: a chat that has to start first isn't "Not sent" while it still goes through
        if (!r.ok) {
            out.refused = r.status === 409;
            throw new Error(await r.text());
        }
        out.okAt = Date.now();
        // a slash command's panel or output (control.mjs settleCommand), shown under it as a reply
        const result = /json/.test(r.headers.get('content-type') ?? '') ? await r.json() : null;
        if (result) {
            out.result = result;
        }
        const said = result ? result.warning ?? 'ok' : await r.text();
        out.answered = said === 'answered'; // it went into the open question's text box (control.mjs send)
        out.sending = !(out.answered || text.startsWith('/')); // those never land in the transcript as the user's: done once sent
        if ((draftSid ?? startingTarget()) === sid) {
            $('c-err').textContent = said === 'ok' || out.answered ? '' : said; // sent, with a warning (running twice)
        }
        answered(sid);
        setTimeout(refreshChat, 1000);
        return true;
    } catch (err) {
        if (err.name === 'TimeoutError') {
            // no answer is not a refusal: the server may still type it. Not confirmed (the transcript drops the bubble
            // once it has the text, and Retry looks there first), and the text is not handed back to be sent twice.
            out.sending = false;
            out.unconfirmed = true;
            if ((draftSid ?? startingTarget()) === sid) {
                $('c-err').textContent = 'Homebase did not answer in 45 s, so this may or may not have reached Claude.';
            }
            refreshChat();
            return true;
        }
        if (/typing can't answer/.test(err.message)) { // control.mjs NEEDS_CLICK: the card gets that dialog
            paneCheck = sid;
            refreshChat();
        }
        out.error = friendly(err.message);
        if ((draftSid ?? startingTarget()) === sid) {
            $('c-err').textContent = out.error; // not on another chat switched to meanwhile
        }
        refreshChat();
        return false;
    }
}

// Chat menu toggle: hides FYI bubbles (and tool lines), keeping needs-you, the user's own and the newest Claude bubble.
function setNeedsOnly(on) {
    store.set('needs-only', on ? '1' : '');
    $('feed').classList.toggle('needs-only', on);
    $('needs-only').checked = on;
}

function setAutoCompact(on) {
    store.set('auto-compact', on ? '1' : '0'); // explicit off is kept; unset means on
    $('auto-compact').checked = on;
}

export function initChat() {
    setNeedsOnly(store.get('needs-only') === '1');
    setAutoCompact(store.get('auto-compact') !== '0');
    initNewMarker();
    $('c-back').onclick = unfocusChat;
    $('c-next').onclick = () => nextId && focusChat(nextId);
    document.addEventListener('keydown', e => e.key === 'Escape' && state.focus && !e.composedPath().some(n => /^(INPUT|WA-TEXTAREA|TEXTAREA|WA-DIALOG|WA-DROPDOWN)$/.test(/** @type {Element} */ (n).nodeName || '')) && unfocusChat());
    $('msg').addEventListener('input', () => {
        saveDraft(draftStorage(), draftSid, $('msg'));
    });
    $('send').onsubmit = async e => {
        e.preventDefault();
        const s = chatSession(), ta = $('msg'), files = attached;
        let text = expandPastes(ta.value.trim(), loadPastes());
        if (!text && !files.length) {
            return;
        }
        if (state.boot) {
            $('c-err').textContent = 'Claude is waiting on a startup question above';
            return;
        }
        const target = s?.id ?? startingTarget(); // a project that is still starting has no session id, only its tmux name
        if (!target) {
            return;
        }
        if (files.length) {
            if (uploading) {
                return; // a second Enter while the first upload runs
            }
            $('c-err').textContent = '';
            uploading = true;
            try {
                text = [text, ...await upload(files)].filter(Boolean).join('\n');
            } catch (err) {
                showErr(err.message); // text and images stay for another try
                return;
            } finally {
                uploading = false;
            }
            attached = attached.filter(f => !files.includes(f)); // keeps any attached while uploading
            showAttached();
        }
        // clear at once; the "sending…" bubble shows progress
        ta.value = '';
        const ok = await sendText(target, text);
        if (draftSid !== (s?.id ?? null)) {
            // switched chats meanwhile: the box is the other chat's now, so a failed text goes back into its own chat's draft
            if (!ok && s && !draftStorage()?.getItem(`draft:${s.id}`)) {
                saveDraft(draftStorage(), s.id, /** @type {any} */ ({ value: text }));
            }
        } else if (!ok && !ta.value) {
            // give the text back so it isn't lost
            ta.value = text;
        } else {
            saveDraft(draftStorage(), target, ta); // sent: drops the draft, or keeps whatever was typed meanwhile
        }
    };
    $('plus-menu').addEventListener('wa-select', e => e.detail.item.value === 'files' && $('attach-input').click());
    $('attach-input').onchange = () => {
        attach($('attach-input').files ?? []);
        $('attach-input').value = '';
    };
    $('send').addEventListener('paste', e => {
        const files = [...e.clipboardData?.files ?? []].filter(f => f.type.startsWith('image/'));
        if (files.length) {
            e.preventDefault(); // not also the file's name as text
            attach(files);
            return;
        }
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (isLongPaste(text)) {
            e.preventDefault();
            const ta = $('msg'), sel = /** @type {HTMLTextAreaElement} */ (('input' in ta && ta.input) || ta);
            const label = stashPaste(text.replace(/\r\n?/g, '\n'));
            const start = sel.selectionStart ?? ta.value.length, end = sel.selectionEnd ?? start;
            ta.value = ta.value.slice(0, start) + label + ta.value.slice(end);
            ta.updateComplete?.then(() => ta.setSelectionRange(start + label.length, start + label.length));
            saveDraft(draftStorage(), chatSession()?.id, ta);
        }
    });
    const row = $('send').querySelector('.c-row');
    const hasFiles = /** @param {DragEvent} e */ e => !!e.dataTransfer?.types.includes('Files');
    $('send').addEventListener('dragover', e => {
        if (hasFiles(e)) {
            e.preventDefault();
            row?.classList.add('drop');
        }
    });
    $('send').addEventListener('dragleave', () => row?.classList.remove('drop'));
    $('send').addEventListener('drop', e => {
        row?.classList.remove('drop');
        if (hasFiles(e)) {
            e.preventDefault();
            attach(e.dataTransfer?.files ?? []);
        }
    });
    // On a touch screen Enter adds a line, as its keyboard has no Shift+Enter; the send button (shown there only) sends.
    $('msg').onkeydown = e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch()) {
            e.preventDefault();
            $('send').requestSubmit();
        }
    };
    $('send-btn').onmousedown = e => e.preventDefault(); // the tap leaves the focus in the box, so the phone's keyboard stays up
    // Claude Code takes /model <alias> as a normal message and switches at once (it also saves it as the default for new chats)
    $('c-model').addEventListener('wa-select', async e => {
        const s = chatSession(), alias = e.detail.item.value;
        if (!s || state.asking) {
            return;
        }
        pickedModel = { sid: s.id, name: alias === 'default' ? 'Default' : modelName(alias) ?? alias, at: Date.now() };
        paneCheck = s.id; // Claude may ask "Switch model?" before it switches
        showModel(s);
        try {
            const r = await api(`/api/send?id=${encodeURIComponent(s.id)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `/model ${alias}` });
            if (!r.ok) {
                throw new Error(await r.text());
            }
        } catch (err) {
            pickedModel = null;
            showModel(s);
            $('c-err').textContent = friendly(err.message);
        }
    });
    $('plus-menu').addEventListener('wa-select', e => {
        if (e.detail.item.value === 'push' || e.detail.item.value === 'files') {
            return; // app.js, and above
        }
        const s = chatSession();
        if (!s) {
            return;
        }
        if (e.detail.item.value === 'needs-only') {
            return setNeedsOnly(store.get('needs-only') !== '1'); // from our state, not the item's own toggle
        }
        if (e.detail.item.value === 'auto-compact') {
            return setAutoCompact(store.get('auto-compact') === '0');
        }
        if (e.detail.item.value === 'restart') {
            return void ($('restart-dlg').open = true);
        }
        if (e.detail.item.value === 'compact') {
            return void ($('compact-dlg').open = true);
        }
        if (e.detail.item.value === 'view') {
            store.set(`cleared:${s.id}`, String(Date.now()));
            refreshChat();
        } else {
            $('clear-dlg').open = true;
        }
    });
    $('restart-go').onclick = () => {
        $('restart-dlg').open = false;
        const s = chatSession();
        if (s) {
            restart(s.id);
        }
    };
    $('status-restart').onclick = $('rules-restart').onclick = () => { $('restart-dlg').open = true; };
    $('compact-nudge').onclick = () => { $('compact-dlg').open = true; };
    $('compact-go').onclick = () => {
        $('compact-dlg').open = false;
        const s = chatSession();
        if (s) {
            compact(s.id);
        }
    };
    $('clear-go').onclick = async () => {
        const s = chatSession();
        $('clear-dlg').open = false;
        $('c-err').textContent = '';
        if (!s) {
            return;
        }
        try {
            const r = await api(`/api/clear?id=${encodeURIComponent(s.id)}`, { method: 'POST' });
            if (!r.ok) {
                throw new Error(await r.text());
            }
            store.set(`cleared:${s.id}`, JSON.stringify({ at: Date.now(), mode: 'new' }));
            refreshChat();
        } catch (err) {
            showErr(err.message);
        }
    };
    for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('.c-copy'))) {
        b.addEventListener('click', () => navigator.clipboard.writeText($(b.dataset.copy).textContent).then(() => {
            b.textContent = 'Copied';
            setTimeout(() => { b.textContent = 'Copy'; }, 1500);
        }));
    }
}
