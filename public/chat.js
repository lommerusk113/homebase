// Chat column: bound to one master session, default the most recently active tracked one.
import { $, el, state, store, visibleSessions, updateTitle, rich, foldable, waButton, tooltip, chatStatus } from './core.js';
import { renderBoard } from './list.js';

// only sessions in the selected project(s); falls back to the most recent one there
export const chatSession = () => { const v = visibleSessions(); return v.find(s => s.id === state.chat) || v[0] || null; };
let chatKey = null;
let stick = false; // set by a send: the next render scrolls to the bottom even if the user had scrolled up
let following = null; // session id a /clear was sent to: the chat moves to its successor once the server has mapped it

// cleared:<id> holds a timestamp (Clear view) or {"at","mode":"new"} (New conversation: the same cut, but not a "hidden" one)
export function clearState(raw) {
    let v;
    try { v = JSON.parse(raw); } catch { return { at: 0, fresh: false }; }
    return v && typeof v === 'object' ? { at: Number(v.at) || 0, fresh: v.mode === 'new' } : { at: Number(v) || 0, fresh: false };
}

export function bindChat(id) {
    state.chat = id; store.set('chat', id);
    renderBoard(); refreshChat();
}

function bubble(i, sid) {
    if (i.role === 'tools') return el('div', 'tools', i.text);
    const b = el('div', `bubble ${i.role}${i.error ? ' failed' : ''}${i.interrupted ? ' interrupted' : ''}`), key = `${sid}:${i.at}`;
    // the interrupted mark gets its own tooltip instead of the timestamp
    if (i.at && !i.interrupted) b.title = new Date(i.at).toLocaleString();
    if (i.role === 'assistant') b.append(...foldable(i.tldr, i.text, key));
    else {
        const body = rich(i.text);
        if (!state.unfold.has(key)) body.classList.add('fold');
        b.append(body);
    }
    if (i.interrupted) b.append(tooltip(b, 'Interrupted by you'));
    const note = i.error ? 'Not sent' : i.sending ? 'sending…' : i.pending ? 'queued' : null;
    if (note) {
        const n = el('div', 'b-note', note);
        if (i.pending && !i.sending) {
            const btn = waButton('Send now', 'send-now', { pill: true });
            btn.onclick = () => sendNow(sid, key);
            n.append(btn, tooltip(btn, "Interrupts Claude's current step so your message is handled now"));
        }
        b.append(n);
    }
    b.dataset.key = key;
    return b;
}

// "Show more" only where the fold actually cuts something off; needs layout, so runs after insertion.
function addShowMore(feed) {
    for (const body of feed.querySelectorAll('.body.fold')) {
        if (body.scrollHeight <= body.clientHeight + 4) { body.classList.remove('fold'); continue; }
        const btn = el('button', 'show', 'Show more');
        btn.onclick = () => {
            const key = body.parentElement.dataset.key, open = body.classList.toggle('fold');
            open ? state.unfold.delete(key) : state.unfold.add(key);
            btn.textContent = open ? 'Show more' : 'Show less';
        };
        body.after(btn);
    }
}

// Fixed-height bar at the top of the column: changing it never resizes the feed, so the scroll position stays put.
function setStatus(data) {
    const { kind, text } = chatStatus(data);
    $('status').className = `c-status ${kind}`; $('status-text').textContent = text;
}

// same unwrap as the server's unwrapPasted, plus whitespace collapsed, for matching sent text to transcript text
const norm = t => (t || '').replace(/<pasted_content id="([^"]*)">([\s\S]*?)<\/pasted_content(?: id="\1")?>/g, '$2').replace(/\s+/g, ' ').trim();
export async function refreshChat() {
    const next = following && state.sessions.find(x => x.clearedFrom === following);
    if (next) { following = null; state.chat = next.id; store.set('chat', next.id); renderBoard(); }
    const s = chatSession(), feed = $('feed');
    if (!s) { chatKey = null; state.asking = null; updateTitle(); setStatus(null); return feed.replaceChildren(el('div', 'welcome', 'No session to chat with yet.')); }
    let data;
    try {
        const r = await fetch(`/api/transcript?dir=${encodeURIComponent(s.dir)}&id=${encodeURIComponent(s.id)}`);
        if (!r.ok) throw new Error(await r.text());
        data = await r.json();
    } catch { return; }
    if (chatSession()?.id !== s.id) return; // switched while loading
    setStatus(data);
    $('ask').hidden = !data.asking;
    state.asking = data.asking; updateTitle();
    // ponytail: options are read-only; the docs don't pin down a keypress that picks option N, so answering stays in the terminal
    $('ask-q').replaceChildren(...(data.questions?.length ? data.questions : [{ question: data.asking || '', options: [] }]).flatMap(q => {
        const ol = el('ol'); ol.append(...q.options.map(o => el('li', null, o)));
        return [el('p', null, q.question), ...(q.options.length ? [ol] : [])];
    }));
    $('ask-cmd').textContent = `tmux attach -t ${s.tmux ?? `cc-${s.id.slice(0, 8)}`}`;
    // Optimistic bubbles go once any user/queued/pending item has the same text (sent no earlier than 10s before),
    // or 30s after the send succeeded: the transcript is the source of truth.
    const landed = o => data.items.some(i => i.role === 'user' && norm(i.text) === norm(o.text) && !(Date.parse(i.at) < Date.parse(o.at) - 10_000));
    state.outbox = state.outbox.filter(o => o.sid !== s.id || o.error || !(landed(o) || Date.now() - o.okAt > 30_000));
    // placed by send time, so one sent before a queued message stays above it
    // a queued item whose Send now was clicked shows "sending…" until the queue entry resolves
    state.nudged = new Set(data.items.filter(i => i.pending).map(i => `${s.id}:${i.at}`).filter(k => state.nudged.has(k)));
    const items = data.items.map(i => (i.pending && state.nudged.has(`${s.id}:${i.at}`) ? { ...i, sending: true } : i));
    for (const o of state.outbox.filter(o => o.sid === s.id)) {
        const i = items.findIndex(x => Date.parse(x.at) > Date.parse(o.at));
        items.splice(i < 0 ? items.length : i, 0, o);
    }
    // Clear view: items up to the stored cut-off stay hidden in Homebase only
    const cut = clearState(store.get(`cleared:${s.id}`)), hidden = items.findLastIndex(i => i.at && Date.parse(i.at) <= cut.at) + 1;
    items.splice(0, hidden);
    const fresh = cut.fresh || !!s.clearedFrom; // a New conversation, before or after the successor is bound
    const key = s.id + JSON.stringify([items, data.asking, data.working, hidden]);
    if (key === chatKey) return;
    const first = !chatKey?.startsWith(s.id), atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40, top = feed.scrollTop;
    chatKey = key;
    feed.replaceChildren(...items.map(i => bubble(i, s.id)));
    if (hidden && !cut.fresh) {
        const line = el('div', 'c-hidden', 'Earlier messages hidden · '), btn = el('button', 'show', 'Show');
        btn.onclick = () => { store.set(`cleared:${s.id}`, ''); refreshChat(); };
        line.append(btn); feed.prepend(line);
    } else if (!items.length) feed.append(el('div', 'welcome', fresh ? 'New conversation — say something to Claude' : 'No messages yet.'));
    // Quick replies under Claude's newest message when it ends with a question; an outbox bubble after it hides them.
    const last = items.at(-1);
    if (last?.replies?.length && !data.asking && !data.working) {
        const row = el('div', 'replies');
        row.append(...last.replies.map(t => { const b = waButton(t, null, { variant: 'brand', appearance: 'filled-outlined', pill: true }); b.onclick = () => sendReply(t); return b; }));
        feed.append(row);
    }
    addShowMore(feed);
    feed.scrollTop = first || atBottom || stick ? feed.scrollHeight : top;
    stick = false;
}

async function sendNow(sid, key) {
    state.nudged.add(key); $('c-err').textContent = ''; refreshChat();
    try {
        const r = await fetch(`/api/interrupt?id=${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'x-codetool': '1' } });
        if (!r.ok) throw new Error(await r.text());
    } catch (err) {
        state.nudged.delete(key); $('c-err').textContent = err.message; refreshChat();
    }
}

const syncSend = () => { $('send-btn').disabled = !$('msg').value?.trim(); };

// Types text into a session as an outbox bubble ("sending…", then gone once the transcript has it); false if it failed.
export async function sendText(sid, text) {
    $('c-err').textContent = '';
    const out = { role: 'user', text, sid, at: new Date().toISOString(), sending: true };
    state.outbox = [...state.outbox.filter(o => !o.error), out];
    stick = true;
    refreshChat();
    try {
        const r = await fetch(`/api/send?id=${encodeURIComponent(sid)}`, { method: 'POST', headers: { 'x-codetool': '1', 'content-type': 'text/plain' }, body: text });
        if (!r.ok) throw new Error(await r.text());
        out.okAt = Date.now();
        setTimeout(refreshChat, 1000);
        return true;
    } catch (err) {
        $('c-err').textContent = err.message; out.error = err.message; refreshChat();
        return false;
    }
}
// Through the input's own submit path (outbox, errors); the draft is put back since submit reads the value synchronously.
function sendReply(text) {
    const ta = $('msg'), draft = ta.value;
    ta.value = text; $('send').requestSubmit(); ta.value = draft;
}

export function initChat() {
    $('msg').addEventListener('input', syncSend);
    $('send').onsubmit = async e => {
        e.preventDefault();
        const s = chatSession(), ta = $('msg'), text = ta.value.trim();
        if (!s || !text) return;
        ta.value = ''; syncSend(); // clear at once; the "sending…" bubble shows progress
        if (!await sendText(s.id, text) && !ta.value) { ta.value = text; syncSend(); } // give the text back so it isn't lost
    };
    $('msg').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('send').requestSubmit(); } };
    $('c-menu').addEventListener('wa-select', e => {
        const s = chatSession();
        if (!s) return;
        if (e.detail.item.value === 'view') { store.set(`cleared:${s.id}`, String(Date.now())); refreshChat(); } else $('clear-dlg').open = true;
    });
    $('clear-go').onclick = async () => {
        const s = chatSession();
        $('clear-dlg').open = false; $('c-err').textContent = '';
        if (!s) return;
        try {
            const r = await fetch(`/api/clear?id=${encodeURIComponent(s.id)}`, { method: 'POST', headers: { 'x-codetool': '1' } });
            if (!r.ok) throw new Error(await r.text());
            following = s.id;
            store.set(`cleared:${s.id}`, JSON.stringify({ at: Date.now(), mode: 'new' }));
            refreshChat();
        } catch (err) { $('c-err').textContent = err.message; }
    };
    $('ask-copy').onclick = () => navigator.clipboard.writeText($('ask-cmd').textContent).then(() => { $('ask-copy').textContent = 'Copied'; setTimeout(() => { $('ask-copy').textContent = 'Copy'; }, 1500); });
}
