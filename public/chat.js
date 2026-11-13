// Chat column: bound to one master session, default the most recently active tracked one.
import { api, $, el, state, store, visibleSessions, updateTitle, rich, foldable, waButton, tooltip, chatStatus, setOffline, ctxLevel, canCompact, autoCompactDue } from './core.js';
import { renderBoard } from './list.js';

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
export const chatSession = () => pickChat(visibleSessions(), store.get(bindKey()), state.chat);
let chatKey = null;
let stick = false; // set by a send: the next render scrolls to the bottom even if the user had scrolled up

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
let restored = false; // once per page load, for the first bound session
const draftStorage = () => {
    try {
        return sessionStorage;
    } catch {
        return null;
    }
};

/** @param {string} id */
export function bindChat(id) {
    state.chat = id;
    store.set('chat', id);
    store.set(bindKey(), id);
    renderBoard();
    refreshChat();
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

/** @param {ChatItem} i @param {string} sid @param {string | null} prevTopic @param {{ latest?: boolean, unread?: boolean }} [look] */
function bubble(i, sid, prevTopic, look = {}) {
    if (i.role === 'tools') {
        return el('div', 'tools', i.text);
    }
    if (i.role === 'error') {
        return el('div', 'tools api-error', i.text);
    }
    if (i.role === 'compact') {
        return el('div', 'tools compact', i.text);
    }
    const needs = i.role === 'assistant' && i.needsYou && !i.error;
    const kind = i.role !== 'assistant' || i.error ? '' : needs ? ' needs' : ` fyi${look.latest ? ' latest' : ''}`;
    const b = el('div', `bubble ${i.role}${kind}${i.error ? ' failed' : ''}${i.interrupted ? ' interrupted' : ''}`);
    const key = `${sid}:${i.at}`;
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
            const pill = el('span', 'need-pill', 'needs you');
            if (look.unread) {
                pill.prepend(el('span', 'unread'));
            }
            row.append(pill);
            b.addEventListener('click', () => markRead(sid, key, b));
        }
        b.append(row);
    }
    if (i.role === 'assistant') {
        b.append(...foldable(i.tldr, i.text, key));
    } else {
        const body = rich(i.text);
        if (!state.unfold.has(key)) {
            body.classList.add('fold');
        }
        b.append(body);
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

// Under a user bubble: "Not sent", "sending…" or "queued" (with Send now), else null.
/** @param {ChatItem} i @param {string} sid @param {string} key */
function noteRow(i, sid, key) {

    const note = i.error ? 'Not sent' : i.sending ? 'sending…' : i.pending ? 'queued' : null;
    if (!note) {
        return null;
    }

    const n = el('div', 'b-note', note);
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
    const note = a.error ? `Not sent: ${a.error}` : a.sending ? 'sending…' : a.queued ? 'queued' : null;
    if (note) {
        t.append(` · ${note}`);
    }
    return t;
}

// "Show more" only where the fold actually cuts something off; needs layout, so runs after insertion.
function addShowMore(feed) {
    for (const body of feed.querySelectorAll('.body.fold')) {
        if (body.scrollHeight <= body.clientHeight + 4) {
            body.classList.remove('fold');
            continue;
        }
        const btn = el('button', 'show', 'Show more');
        btn.onclick = () => {
            const key = body.parentElement.dataset.key, folded = body.classList.toggle('fold');
            if (folded) {
                state.unfold.delete(key);
            } else {
                state.unfold.add(key);
            }
            btn.textContent = folded ? 'Show more' : 'Show less';
        };
        body.after(btn);
    }
}

// Fixed-height line above the input (in the fixed-height dock): changing it never resizes the feed, so the scroll position stays put.
/** @param {Parameters<typeof chatStatus>[0]} data */
function setStatus(data) {
    const { kind, text } = chatStatus(data);
    $('status').className = `c-status ${kind}`;
    $('status-text').textContent = text;
}

// same unwrap as the server's unwrapPasted, plus whitespace collapsed, for matching sent text to transcript text
const norm = t => (t || '').replace(/<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content(?: id="\1")?>/g, '$2').replace(/\s+/g, ' ').trim();
// "New session started in …" above the feed, for a newer master in the bound session's project.
/** @param {Session | null} s */
function showNewer(s) {

    const newer = newerSession(visibleSessions(), s);
    $('newer').hidden = !newer;
    if (newer) {
        $('newer-text').textContent = `New session started in ${newer.project} · `;
        $('newer-go').onclick = () => bindChat(newer.id);
    }
}

// The "Claude is asking" panel: its questions and options, and the tmux command to answer in the terminal.
/** @param {Session} s @param {Transcript} data */
function showAsk(s, data) {

    $('ask').hidden = !data.asking;
    state.asking = data.asking;
    updateTitle();

    // ponytail: options are read-only; the docs don't pin down a keypress that picks option N, so answering stays in the terminal
    const questions = data.questions?.length ? data.questions : [{ question: data.asking || '', options: [] }];
    $('ask-q').replaceChildren(...questions.flatMap(q => {
        const ol = el('ol');
        ol.append(...q.options.map(o => el('li', null, o)));

        return [el('p', null, q.question), ...(q.options.length ? [ol] : [])];
    }));
    $('ask-cmd').textContent = `tmux attach -t ${s.tmux ?? `cc-${s.id.slice(0, 8)}`}`;
}

const LANDED_SLACK_MS = 10_000; // a transcript item may predate the send it matches by this much
const OUTBOX_TTL_MS = 30_000; // after a successful send, the bubble goes even if nothing matched it

// The transcript's items merged with this session's outbox, minus what Clear view hides; prunes state.outbox and
// state.nudged on the way. hidden: how many items the cut-off removed from the front.
/** @param {Session} s @param {Transcript} data @returns {{ items: ChatItem[], hidden: number, cut: { at: number, fresh: boolean } }} */
function feedItems(s, data) {

    // Optimistic bubbles go once any user/queued/pending item (or answer) has the same text, sent no earlier than
    // LANDED_SLACK_MS before, or OUTBOX_TTL_MS after the send succeeded: the transcript is the source of truth.
    const sameSend = (text, at, o) => norm(text) === norm(o.text) && !(Date.parse(at) < Date.parse(o.at) - LANDED_SLACK_MS);
    const landed = /** @param {OutboxItem} o */ o => data.items.some(i => (i.role === 'user' && sameSend(i.text, i.at, o))
        || (i.answer && sameSend(i.answer.text, i.answer.at, o)));
    state.outbox = state.outbox.filter(o => o.sid !== s.id || o.error || !(landed(o) || Date.now() - o.okAt > OUTBOX_TTL_MS));

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
                items[q] = { ...items[q], answer: { text: o.text, sending: !o.error, error: o.error } };
            }
            continue;
        }
        const i = items.findIndex(x => Date.parse(x.at) > Date.parse(o.at));
        items.splice(i < 0 ? items.length : i, 0, o);
    }

    // Clear view: items up to the stored cut-off stay hidden in Homebase only
    const cut = clearState(store.get(`cleared:${s.id}`));
    const hidden = items.findLastIndex(i => i.at && Date.parse(i.at) <= cut.at) + 1;
    items.splice(0, hidden);

    return { items, hidden, cut };
}

// Quick replies under Claude's newest message when it ends with a question; an outbox bubble after it hides them.
/** @param {Session} s @param {Transcript} data @param {ChatItem | undefined} last */
function quickReplyRow(s, data, last) {

    if (!(last?.replies?.length && (!last.answer || last.answer.error) && !data.asking && !data.working)) {
        return null;
    }

    const row = el('div', 'replies');
    row.append(...last.replies.map(t => {
        const b = waButton(t, null, { variant: 'brand', appearance: 'filled-outlined', pill: true });
        b.onclick = () => sendText(s.id, t, last.at);

        return b;
    }));

    return row;
}

const NEAR_BOTTOM_PX = 40; // this close to the bottom counts as reading the newest: a re-render keeps it in view

export async function refreshChat() {

    const s = chatSession(), feed = $('feed');
    // persist the binding, or a successor it moved to
    if (s && store.get(bindKey()) !== s.id) {
        store.set(bindKey(), s.id);
        renderBoard();
    }
    showNewer(s);
    if (s && !restored) {
        restored = true;
        restoreDraft(draftStorage(), s.id, $('msg')).then(ok => ok && syncSend());
    }
    if (!s) {
        $('compact-item').disabled = true;
        $('compact-nudge').hidden = true;
        chatKey = null;
        state.asking = null;
        updateTitle();
        setStatus(state.offline ? { error: true } : null);
        return feed.replaceChildren(el('div', 'welcome', state.starting ? 'Chat starting…' : 'No session to chat with yet.'));
    }

    /** @type {Transcript} */
    let data;
    try {
        const r = await api(`/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}`);
        if (!r.ok) {
            throw new Error(await r.text());
        }
        data = await r.json();
    } catch {
        setOffline(true);
        return setStatus({ error: true });
    }
    if (chatSession()?.id !== s.id) {
        return; // switched while loading
    }

    setStatus(data);
    showAsk(s, data);
    compactUi(s, data);

    const { items, hidden, cut } = feedItems(s, data);
    const fresh = cut.fresh || !!s.clearedFrom; // a New conversation, before or after the successor is bound
    const key = s.id + JSON.stringify([items, data.asking, data.working, hidden]);
    if (key === chatKey) {
        return;
    }

    const first = !chatKey?.startsWith(s.id);
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < NEAR_BOTTOM_PX;
    const top = feed.scrollTop;
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
    let topic = null;
    feed.replaceChildren(...items.map((i, n) => {
        const prev = topic;
        if (i.role === 'assistant') {
            topic = i.topic;
        }

        return bubble(i, s.id, prev, { latest: n === latest, unread: unread(i, n) });
    }));

    if (hidden && !cut.fresh) {
        const line = el('div', 'c-hidden', 'Earlier messages hidden · '), btn = el('button', 'show', 'Show');
        btn.onclick = () => {
            store.set(`cleared:${s.id}`, '');
            refreshChat();
        };
        line.append(btn);
        feed.prepend(line);
    } else if (!items.length) {
        feed.append(el('div', 'welcome', fresh ? 'New conversation — say something to Claude' : 'No messages yet.'));
    }
    const replies = quickReplyRow(s, data, items.at(-1));
    if (replies) {
        feed.append(replies);
    }

    addShowMore(feed);
    feed.scrollTop = first || atBottom || stick ? feed.scrollHeight : top;
    stick = false;
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
        $('c-err').textContent = err.message;
        refreshChat();
    }
}

// The menu item and the "Compact?" nudge follow the bound session; the auto mode piggybacks on the same poll.
/** @param {Session} s @param {Transcript} data */
function compactUi(s, data) {

    const idle = canCompact(s) && !data.working && !data.asking;
    $('compact-item').disabled = !idle;
    $('compact-nudge').hidden = !(idle && ctxLevel(s.context ?? 0));
    if (idle && store.get('auto-compact') === '1') {
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
        $('c-err').textContent = err.message;
    }
}

const syncSend = () => { $('send-btn').disabled = !$('msg').value?.trim(); };

// Types text into a session as an outbox bubble ("sending…", then gone once the transcript has it); false if it failed.
/** @param {string} sid @param {string} text @param {string} [answerTo] @returns {Promise<boolean>} */
export async function sendText(sid, text, answerTo) {
    $('c-err').textContent = '';
    /** @type {OutboxItem} */
    const out = { role: 'user', text, sid, at: new Date().toISOString(), sending: true, answerTo };
    state.outbox = [...state.outbox.filter(o => !o.error), out];
    stick = true;
    refreshChat();
    try {
        const r = await api(`/api/send?id=${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: text });
        if (!r.ok) {
            throw new Error(await r.text());
        }
        out.okAt = Date.now();
        setTimeout(refreshChat, 1000);
        return true;
    } catch (err) {
        $('c-err').textContent = err.message;
        out.error = err.message;
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
    store.set('auto-compact', on ? '1' : '');
    $('auto-compact').checked = on;
}

export function initChat() {
    setNeedsOnly(store.get('needs-only') === '1');
    setAutoCompact(store.get('auto-compact') === '1');
    $('msg').addEventListener('input', () => {
        syncSend();
        saveDraft(draftStorage(), chatSession()?.id, $('msg'));
    });
    $('send').onsubmit = async e => {
        e.preventDefault();
        const s = chatSession(), ta = $('msg'), text = ta.value.trim();
        if (!s || !text) {
            return;
        }
        // clear at once; the "sending…" bubble shows progress
        ta.value = '';
        syncSend();
        if (!await sendText(s.id, text) && !ta.value) {
            // give the text back so it isn't lost
            ta.value = text;
            syncSend();
        } else {
            saveDraft(draftStorage(), s.id, ta); // sent: drops the draft, or keeps whatever was typed meanwhile
        }
    };
    $('msg').onkeydown = e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            $('send').requestSubmit();
        }
    };
    $('c-menu').addEventListener('wa-select', e => {
        const s = chatSession();
        if (!s) {
            return;
        }
        if (e.detail.item.value === 'needs-only') {
            return setNeedsOnly(store.get('needs-only') !== '1'); // from our state, not the item's own toggle
        }
        if (e.detail.item.value === 'auto-compact') {
            return setAutoCompact(store.get('auto-compact') !== '1');
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
            $('c-err').textContent = err.message;
        }
    };
    $('ask-copy').onclick = () => navigator.clipboard.writeText($('ask-cmd').textContent).then(() => {
        $('ask-copy').textContent = 'Copied';
        setTimeout(() => { $('ask-copy').textContent = 'Copy'; }, 1500);
    });
}
