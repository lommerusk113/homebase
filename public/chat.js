// Chat column: bound to one master session, default the most recently active tracked one.
import { api, $, el, state, store, visibleSessions, updateTitle, setOffline, waitsOnYou, composer, vue } from './core.js';
import { renderBoard, sessionTopic } from './list.js';
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
export const startingTarget = () => (state.startingTmux === `cc-new-${state.project}` ? state.startingTmux : null);
let chatKey = null;
let stick = false; // set by a send: the next render scrolls to the bottom even if the user had scrolled up
export const stickFeed = () => { stick = true; };
const FEED_STEP = 60; // items per load; "Show earlier" adds this many
let feedMax = { sid: '', max: FEED_STEP };
// "Show earlier" in the feed: one more step of older items.
export function showEarlier() {
    feedMax.max += FEED_STEP;
    refreshChat();
}

// The message list is a Vue island (web/src/islands/Feed.vue). Its composables set these two when web/dist loads:
// merge is the transcript's items with the session's outbox, minus what Clear view hides (it prunes state.outbox and
// state.nudged on the way; hidden: how many items the cut-off took off the front), show draws a feed.
/** @typedef {{ sid: string | null, items: ChatItem[], data?: Transcript, hidden?: number, cutFresh?: boolean, fresh?: boolean, lastSeen?: number, first?: boolean, stick?: boolean, starting?: boolean }} FeedInput */
/** @type {{ merge: ((s: Session, data: Transcript) => { items: ChatItem[], hidden: number, cut: { at: number, fresh: boolean } }) | null, show: ((v: FeedInput) => void) | null }} */
export const feedPort = { merge: null, show: null };

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
/** @param {string} id @param {{ id: string, description: string } | null} [helper] a helper of that chat to step in on @param {string | null} [askedFor] the helper whose question this chat relays */
export function focusChat(id, helper = null, askedFor = null) {
    clearTimeout(returnTimer);
    const shown = !activeHelper() && chatSession()?.id;
    composer.endDiscuss(); // a Discuss started on the chat we leave is not about this one
    state.helper = helper && { sid: id, ...helper };
    state.askedFor = askedFor;
    nextId = null;
    $('c-next').hidden = true;
    state.focus = id;
    followFocus();
    renderBoard();
    refreshChat();
    // the pane already showed this chat (the main chat's own row, or a second click): nothing would change, so its question comes into view
    if (!helper && shown && chatSession()?.id === shown) {
        jumpToNeeds();
    }
    document.dispatchEvent(new Event('chat-focused')); // the phone layout shows the chat pane (app.js)
}
// Step in: a helper's own conversation in the pane, over the chat that started it (its sid); null when not showing one.
/** @returns {{ sid: string, id: string, description: string } | null} */
export const activeHelper = () => (state.helper && state.helper.sid === state.focus ? state.helper : null);
// A focused chat that was /clear'ed moves on to its successor, as the main binding does (pickChat); landing on the main chat ends the focus.
function followFocus() {
    const visible = visibleSessions();
    if (activeHelper() || !state.focus || !visible.some(s => s.id === state.focus)) {
        return;
    }
    const to = pickChat(visible, state.focus, null)?.id;
    state.focus = to === pickChat(visible, store.get(bindKey()), state.chat)?.id ? null : to;
}
// After a focused question is answered the user stays in that chat (Back or Esc leaves); when another chat waits on the
// user, the header offers "Next: <title> →". Nothing but a user action moves the pane.
let returnTimer;
let nextId = null;
/** @param {string} sid */
export function answered(sid) {
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
        }
    }, 1500);
}
export function unfocusChat() {
    clearTimeout(returnTimer);
    const helper = activeHelper();
    if (helper) {
        return focusChat(helper.sid); // back to the chat that started it
    }
    if (state.focus) {
        composer.endDiscuss();
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
export function focusWanted(sid) {
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
export function focusComposer(e) {
    if (/** @type {MouseEvent} */ (e).detail === 0 && document.activeElement === e.currentTarget) {
        $('msg').focus({ preventScroll: true });
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

// Scrolls to and focuses what needs the user: the ask card when it shows, else the reply the pinned strip is about,
// else the newest needs-you bubble.
export function jumpToNeeds() {

    const waiting = !$('wait').hidden && $('feed').querySelector(`[data-key="${CSS.escape($('wait').dataset.key ?? '')}"]`);
    const t = /** @type {HTMLElement | undefined} */ (!$('ask').hidden ? $('ask') : waiting || [...$('feed').querySelectorAll('.bubble.needs')].at(-1));
    if (!t) {
        return;
    }

    t.tabIndex = -1;
    t.scrollIntoView({ block: 'nearest' });
    t.focus({ preventScroll: true });
}

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

// The chat card's top strip (back, branch chips, Changes).
/** @param {Session | null} s */
function showHead(s) {

    const off = !!s && s.id === state.focus; // not on the main chat: a focused chat or a helper
    $('c-back').hidden = !off;
    $('chat').classList.toggle('off-main', off);
    const helper = activeHelper();
    $('c-name').textContent = helper ? `Helper · ${helper.description}` : off ? s.title || sessionTopic(s) : s ? `Main chat · ${s.title || sessionTopic(s)}` : 'Main chat';
    $('c-back').textContent = helper ? `← Back to ${s.title || sessionTopic(s)}` : '← Back to main';
    const hash = helper ? `#chat=${encodeURIComponent(helper.sid)}&agent=${encodeURIComponent(helper.id)}` : '';
    if (location.hash !== hash) {
        history.replaceState(null, '', location.pathname + location.search + hash); // a reload comes back to the helper
    }
    $('c-next').hidden = $('c-back').hidden || !nextId;
    const branch = $('c-branch'), un = $('c-unpushed');
    branch.hidden = !s?.branch;
    branch.textContent = branch.title = s?.branch ?? '';
    branch.classList.toggle('warn', /^(main|master)$/.test(s?.branch ?? '') && !s?.hobby);
    un.hidden = !(s?.unpushed > 0);
    un.textContent = `${s?.unpushed} unpushed`;
    const push = $('c-push');
    push.hidden = un.hidden || !!s?.pushBlocked;
    if (push.hidden || push.dataset.sid !== s?.id) {
        push.dataset.sid = s?.id ?? '';
        $('c-push-err').hidden = true;
    }
    syncDiff(s);
}

// Push: the server decides what may go (never a work repo's default branch, never a force); its last git error line shows next to the button.
async function pushHead() {

    const s = chatSession(), push = /** @type {HTMLButtonElement} */ ($('c-push')), err = $('c-push-err');
    if (!s || push.disabled) {
        return;
    }
    push.disabled = true;
    push.textContent = 'Pushing…';
    err.hidden = true;
    try {
        const r = await api('/api/push', { method: 'POST', body: JSON.stringify({ session: s.id }) });
        if (!r.ok) {
            throw new Error((await r.text()) || `Push failed (${r.status})`);
        }
        s.unpushed = (await r.json()).unpushed;
    } catch (e) {
        err.textContent = err.title = e instanceof Error ? e.message : 'Push failed';
        err.hidden = false;
    }
    push.disabled = false;
    push.textContent = 'Push';
    showHead(chatSession());
}

// Above a focused (not main) chat's question: what it is about, its title and linked MR, then its last reply's TLDR.
/** @param {Session} s @param {ChatItem[]} items */
function showFocus(s, items) {

    const box = $('c-focus'), on = s.id === state.focus;
    box.hidden = !on;
    if (!on) {
        return;
    }
    const helper = activeHelper();
    if (helper) {
        return box.replaceChildren(el('b', null, `Helper: ${helper.description}`));
    }
    if (state.askedFor) {
        box.replaceChildren(el('b', null, `Asked for helper '${state.askedFor}'`), el('div', null, s.title || s.topic || ''));
        return;
    }

    const x = state.sessions.flatMap(o => o.items || []).find(i => i.sessionId === s.id && i.pr);
    const last = items.findLast(i => i.role === 'assistant' && !i.error);
    const say = last && (last.tldr || last.text.split('\n').find(l => l.trim()) || '').trim().slice(0, 220);
    box.replaceChildren(el('b', null, [s.title || s.topic, x && `${x.title} (${x.pr.split('/').pop()})`].filter(Boolean).join(' · ') || s.project), ...(say ? [el('div', null, say)] : []));
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
export const answerNote = (items, n) => (n === items.length - 1 ? undefined : `(Answering your earlier question from ${items[n].at}: "${questionExcerpt(items[n])}")`);

let refreshSeq = 0; // a refresh that finishes after a newer one started is stale: it must not render over it

export async function refreshChat() {

    const seq = ++refreshSeq;
    if (!feedPort.merge) {
        await vue.load(); // the feed island's module, which sets feedPort
    }
    followFocus();
    const s = chatSession();
    vue.bump(); // the composer follows the chat
    // persist the binding, or a successor it moved to
    if (s && !state.focus && store.get(bindKey()) !== s.id) {
        store.set(bindKey(), s.id);
        renderBoard();
    }
    showNewer(state.focus ? null : s);
    showHead(s);
    await composer.boot(s ? null : state.startingTmux); // only a chat still starting: a running one's ❯ prompts and questions aren't startup dialogs
    if (!s) {
        chatKey = null;
        state.asking = null;
        composer.wait(null, null, []);
        updateTitle();
        composer.turn(state.offline ? { error: true } : null);
        // a message sent to a starting project (by tmux name) shows until its session binds
        const sent = state.outbox.filter(o => o.sid === startingTarget());
        return feedPort.show({ sid: startingTarget(), items: sent, starting: !!state.starting });
    }

    /** @type {Transcript} */
    let data;
    const helper = activeHelper();
    const feedSid = helper ? `${s.id}:${helper.id}` : s.id;
    if (feedMax.sid !== feedSid) {
        feedMax = { sid: feedSid, max: FEED_STEP };
    }
    try {
        const r = await api(helper ? `/api/agent-feed?session=${encodeURIComponent(s.id)}&agent=${encodeURIComponent(helper.id)}&max=${feedMax.max}` : `/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}&max=${feedMax.max}`);
        if (!r.ok) {
            throw Object.assign(new Error(await r.text()), { status: r.status });
        }
        data = await r.json();
    } catch (e) {
        setOffline(true, e.status);
        return composer.turn({ error: true });
    }
    if (chatSession()?.id !== s.id || seq !== refreshSeq) {
        return; // switched while loading, or a newer refresh took over
    }

    composer.turn(data);
    state.asking = data.asking;
    updateTitle();
    await composer.ask(s, data);
    if (seq !== refreshSeq) {
        return;
    }

    if (helper) {
        // its own messages as they are: no outbox, no clear cut, no questions to answer from here
        composer.wait(s, data, []);
        showFocus(s, []);
        const items = data.items.map(({ replies, needsYou, ...i }) => i);
        const key = feedSid + JSON.stringify([items, data.working, data.more, data.capped]);
        if (key !== chatKey) {
            const first = !chatKey?.startsWith(feedSid);
            chatKey = key;
            feedPort.show({ sid: feedSid, items, data: { ...data, asking: null }, first, stick });
            stick = false;
        }
        return;
    }
    const { items, hidden, cut } = feedPort.merge(s, data);
    announceReply(s, data, items);
    composer.wait(s, data, items);
    showFocus(s, items);
    const lastSeen = Number(store.get(`last-seen:${s.id}`)) || Infinity;
    const key = s.id + JSON.stringify([items, data.asking, data.working, hidden, data.more, data.capped, lastSeen]);
    if (key === chatKey) {
        return focusWanted(s.id);
    }

    const first = !chatKey?.startsWith(s.id);
    chatKey = key;
    // fresh: a New conversation, before or after the successor is bound. The island calls focusWanted once it has drawn.
    feedPort.show({ sid: s.id, items, data, hidden, cutFresh: cut.fresh, fresh: cut.fresh || !!s.clearedFrom, lastSeen, first, stick });
    stick = false;
}

// Types text into a session as an outbox bubble; false if it failed. The composer's composable does it (web/src/composables/useSend.ts).
/** @param {string} sid @param {string} text @param {string} [answerTo] @param {string} [note] @param {boolean} [canned] @param {string} [once] @returns {Promise<boolean>} */
export const sendText = (sid, text, answerTo, note, canned, once) => composer.send(sid, text, answerTo, note, canned, once);

// Chat menu toggle: hides FYI bubbles (and tool lines), keeping needs-you, the user's own and the newest Claude bubble.
/** @param {boolean} on */
export function setNeedsOnly(on) {
    store.set('needs-only', on ? '1' : '');
    $('feed').classList.toggle('needs-only', on);
}

export function initChat() {
    setNeedsOnly(store.get('needs-only') === '1');
    // the feed, the composer and the question cards
    vue.load().then(m => {
        m?.mount('Feed', $('feed'), { scroller: $('feed') });
        m?.mount('Composer', $('composer'));
        m?.mount('Ask', $('asks'));
        m?.mount('Wait', $('wait-host'));
        m?.mount('Rules', $('rules-host'));
    });
    $('c-back').onclick = unfocusChat;
    $('c-push').onclick = pushHead;
    $('c-next').onclick = () => nextId && focusChat(nextId);
    document.addEventListener('keydown', e => e.key === 'Escape' && state.focus && !e.composedPath().some(n => /^(INPUT|WA-TEXTAREA|TEXTAREA|WA-DIALOG|WA-DROPDOWN)$/.test(/** @type {Element} */ (n).nodeName || '')) && unfocusChat());
}
