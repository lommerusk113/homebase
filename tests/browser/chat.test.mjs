import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { sleep } from './cdp.mjs';
import { chatItems, chatFeed } from '../../server.mjs';

const feedHas = t => `document.getElementById('feed').textContent.includes(${JSON.stringify(t)})`;
const bubble = text => `[...document.querySelectorAll('#feed .bubble')].find(b => b.textContent.includes(${JSON.stringify(text)}))`;

// Puts a fixture transcript back after fn, so a later test still sees its chat as idle.
async function restored(path, fn) {

    const body = readFileSync(path), { atime, mtime } = statSync(path);
    try {
        await fn();
    } finally {
        writeFileSync(path, body);
        utimesSync(path, atime, mtime);
    }
}

// A w x h PNG: grey, or noise (megabytes, slow to decode, as a real screenshot is) when noisy.
function png(w, h, noisy = false) {

    const chunk = (type, data) => {
        const body = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), sum = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        sum.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, sum]);
    };
    const head = Buffer.alloc(13);
    head.writeUInt32BE(w, 0);
    head.writeUInt32BE(h, 4);
    head[8] = 8;
    const rows = noisy ? randomBytes((w + 1) * h) : Buffer.alloc((w + 1) * h, 128);
    for (let y = 0; noisy && y < h; y++) {
        rows[y * (w + 1)] = 0; // each row's filter byte
    }

    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// Opens gamma's chat grown to 25 questions and replies, questions 5 and 23 with a pasted image (or those in `shots`:
// question → noisy), and runs
// fn(add, fromBottom): add(n, more) appends question and reply n (more: further text for the reply), fromBottom is the page expression for the feed's distance to its end.
async function withImageChat({ page, open, IDS, homebase }, fn, shots = { 5: false, 23: false }) {

    const home = join(dirname(homebase), 'home'), file = join(home, '.claude', 'projects', '-fx-gamma', `${IDS.gamma}.jsonl`);
    const base = { isSidechain: false, cwd: join(home, 'repos', 'gamma'), sessionId: IDS.gamma, version: '2.1.322', gitBranch: 'main' };
    const at = s => new Date(Date.now() - s * 1000).toISOString();
    const turn = (k, s, image = '', more = '') => [
        { ...base, type: 'user', uuid: `iu${k}`, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: `question ${k}${image}` } },
        { ...base, type: 'assistant', uuid: `ia${k}`, timestamp: at(s - 5), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply ${k}\n\nline two of reply ${k}${more}` }] } },
        { ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(s - 6) }
    ];
    const put = lines => appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    mkdirSync(join(homebase, 'uploads'), { recursive: true });
    const image = n => {
        const path = join(homebase, 'uploads', `00000000-0000-4000-8000-${String(n).padStart(12, '0')}.png`);
        writeFileSync(path, shots[n] ? png(2600, 1800, true) : png(400, 300));
        return `\n[Image: ${path}]`;
    };
    await restored(file, async () => {
        put(Array.from({ length: 25 }, (_, k) => turn(k, 900 - k * 10, k in shots ? image(k) : '')).flat());
        await open({ project: 'gamma', chat: IDS.gamma });
        await page.waitFor(`${feedHas('reply 24')} && [...document.querySelectorAll('#feed img')].every(i => i.offsetHeight > 50)`, { what: 'the long chat and its thumbnails' });
        await sleep(300);
        await fn(async (n, more) => {
            put(turn(n, 5, '', more));
            await page.waitFor(`${feedHas(`reply ${n}`)} && [...document.querySelectorAll('#feed img')].every(i => i.offsetHeight > 50)`, { what: `reply ${n}`, timeout: 8000 });
            await sleep(400); // a redrawn thumbnail has loaded again
        }, `(() => { const f = document.getElementById('feed'); return Math.round(f.scrollHeight - f.scrollTop - f.clientHeight); })()`);
    });
}

const ready = page => page.waitFor(`${bubble('tag the release')}`, { what: 'the newest master bubble' });

export default {
    'Clear view hides what came before the cut, and Show brings it back': async ({ page, open, IDS }) => {
        await open({ [`cleared:${IDS.master}`]: String(Date.now() - 150_000) });
        await ready(page);
        assert.equal(await page.ev(`!!${bubble('Fix the login redirect bug')}`), false);
        assert.equal(await page.ev(`document.querySelector('#feed').firstElementChild.className`), 'c-hidden');
        await page.click('#feed .c-hidden button');
        await page.waitFor(`${bubble('Fix the login redirect bug')}`, { what: 'the hidden history to come back' });
    },

    'a New conversation cut hides the history without the Show line': async ({ page, open, IDS }) => {
        await open({ [`cleared:${IDS.master}`]: JSON.stringify({ at: Date.now() - 150_000, mode: 'new' }) });
        await ready(page);
        assert.equal(await page.ev(`!!${bubble('Fix the login redirect bug')}`), false);
        assert.equal(await page.ev(`!!document.querySelector('#feed .c-hidden')`), false);
    },

    'history renders, including what came before a huge tool result': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.ok(await page.ev(`!!${bubble('Fix the login redirect bug')}?.classList.contains('user')`), 'first prompt, before the 2 MB line');
        assert.ok(await page.ev(`[...document.querySelectorAll('#feed .tools')].some(t => t.textContent === 'Ran 1 command')`), 'tool summary line');
        assert.equal(await page.ev(`document.getElementById('feed').scrollHeight - document.getElementById('feed').scrollTop - document.getElementById('feed').clientHeight < 40`), true, 'scrolled to the bottom');
    },

    'topic headers and needs-you marking': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .b-topic-name')].map(t => t.textContent)`), ['Fix login', 'Release'], 'a header only where the topic changes');
        assert.ok(await page.ev(`${bubble('tag the release')}.matches('.bubble.assistant.needs.topical') && ${bubble('tag the release')}.querySelector('.need-pill').textContent === 'needs you'`));
        assert.ok(await page.ev(`${bubble('cookie scope')}.matches('.fyi') && !${bubble('cookie scope')}.querySelector('.need-pill')`), 'a question the user has replied to no longer needs them');
        assert.ok(await page.ev(`${bubble('push the branch')}.matches('.fyi')`), 'a plain reply is FYI');
    },

    '"Claude needs your answer" and the needs-you pill scroll to and focus the newest needs-you bubble': async ({ page, open }) => {
        await open();
        await ready(page);
        const last = `[...document.querySelectorAll('#feed .bubble.needs')].at(-1)`;
        const inView = `(() => { const f = document.getElementById('feed').getBoundingClientRect(), b = ${last}.getBoundingClientRect(); return b.top >= f.top - 1 && b.bottom <= f.bottom + 1; })()`;
        for (const go of ['#status-text button', '#feed .need-pill']) {
            await page.ev(`document.activeElement.blur(), document.getElementById('feed').scrollTop = 0`);
            await page.click(go);
            await page.waitFor(`document.activeElement === ${last}`, { what: `${go} to focus the needs-you bubble` });
            assert.ok(await page.ev(inView), `${go}: the bubble is scrolled into view`);
        }
    },

    'the input names the bound project': async ({ page, open }) => {
        await open();
        await ready(page);
        await page.waitFor(`document.getElementById('msg').getAttribute('placeholder') === 'Message Claude in alpha…'`, { what: 'the project in the placeholder' });
    },

    'TLDR folds the rest of the message': async ({ page, open }) => {
        await open();
        await ready(page);
        const b = bubble('tag the release');
        assert.equal(await page.ev(`${b}.querySelector('.lead').textContent`), 'Should I tag the release now or wait for QA?');
        assert.equal(await page.ev(`${b}.querySelector('.body').hidden`), true);
        assert.equal(await page.ev(`${b}.querySelector('button.show').textContent`), 'Show more');
        await page.clickOn(`${b}.querySelector('button.show')`);
        await page.waitFor(`!${b}.querySelector('.body').hidden && ${b}.querySelector('button.show').textContent === 'Show less'`, { what: 'the body to unfold' });
        assert.match(await page.ev(`${b}.querySelector('.body').textContent`), /The notes cover the login redirect/);
    },

    'quick replies under a closing question send as an answer tag': async ({ page, open, IDS }) => {
        await open();
        await ready(page);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .replies wa-button')].map(b => b.firstChild.textContent)`), ['Yes', 'Do both', 'No']);
        assert.ok(await page.ev(`!!${bubble('tag the release')}.querySelector('.replies')`), 'the options sit inside the card that asks');
        await page.click('#feed .replies wa-button:last-child');
        await page.waitFor(`${bubble('tag the release')}.querySelector('.answer')?.textContent === '✕ You: No · sending…'`, { what: 'the answer tag' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'No']]);
        assert.equal(await page.ev(`document.querySelector('#feed .replies')`), null, 'chips gone once answered');
    },

    'a chip on an older question names it and answers that question': async ({ page, open, IDS, answerPosts }) => {
        const say = (text, at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
        const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } };
        const items = chatItems([say('Done.\n\nTLDR: Should I tag the release?', '2026-11-14T10:00:00.000Z'), tool, say('The notes are on the wiki.\n\nTLDR: Should I link them from the README?', '2026-11-14T10:01:00.000Z')]);
        await open();
        await ready(page);
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: true, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        await page.waitFor(`${bubble('link them from the README')}`, { what: 'the newest bubble' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .replies')].map(r => r.closest('.bubble').textContent.includes('README'))`), [false], 'chips only under the older question while Claude works');
        await page.clickOn(`${bubble('tag the release')}.querySelector('.replies wa-button:last-child')`);
        await page.waitFor(`${bubble('tag the release')}.querySelector('.answer')?.textContent === '✕ You: No · sending…'`, { what: 'the answer tag on the older question' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]),
            [[`/api/send?id=${IDS.master}`, 'No\n\n(Answering your earlier question from 2026-11-14T10:00:00.000Z: "Should I tag the release?")']]);
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .bubble.user')].length`), 0, 'no bubble with the note');
    },

    'a listed choice shows its options under the TLDR while folded, one chip each, and a chip sends its label': async ({ page, open, IDS, answerPosts }) => {
        const items = chatItems([{ type: 'assistant', timestamp: '2026-11-14T10:00:00.000Z', message: { content: [{ type: 'text',
            text: '**▸ Database · needs you**\n\nThe schema works on both, migrations differ.\n\nWhich one should be the default?\n1. **Postgres** (Recommended) — what prod runs\n2. **SQLite** — no server\n\n**TLDR:** pick the default database, **Postgres** recommended' }] } }]);
        await open();
        await ready(page);
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        const b = bubble('pick the default database');
        await page.waitFor(`${b}?.querySelector('.b-options')`, { what: 'the options outside the fold' });
        assert.equal(await page.ev(`${b}.querySelector('.body:not(.b-options)').hidden`), true, 'the rest is folded');
        assert.match(await page.ev(`${b}.querySelector('.b-options').textContent`), /Which one should be the default\?[\s\S]*Postgres[\s\S]*SQLite/);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .replies wa-button')].map(c => [c.firstChild.textContent, c.querySelector('.rec')?.textContent, c.getAttribute('appearance')])`),
            [['Postgres', 'Recommended', 'accent'], ['SQLite', null, 'outlined']], 'one chip per option, the recommended one primary');
        await page.click('#feed .replies wa-button:last-child');
        await page.waitFor(`${b}.querySelector('.answer')?.textContent === '✓ You: SQLite · sending…'`, { what: 'the answer tag' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'SQLite']]);
    },

    'an AskUserQuestion answered in the card leaves no chips on the message that asked': async ({ page, open, answerPosts }) => {
        const items = chatItems([
            { type: 'assistant', timestamp: '2026-11-14T10:00:00.000Z', message: { content: [{ type: 'text', text: '**▸ Database · needs you**\n\n**TLDR:** Which database should be the default?' }] } },
            { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] } }] } },
            { type: 'user', timestamp: '2026-11-14T10:01:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'q1' }] }, toolUseResult: { answers: { 'Which database?': 'Postgres' } } }
        ]);
        await open();
        await ready(page);
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        const b = bubble('Which database should be the default');
        await page.waitFor(`${b}?.querySelector('.answer')?.textContent === '✓ You: Postgres'`, { what: 'the card answer as the answer tag' });
        assert.equal(await page.ev(`document.querySelector('#feed .replies')`), null, 'no chips');
        assert.equal(await page.ev(`!!${b}.querySelector('.need-pill')`), false, 'no longer needs you');
    },

    'a short reply becomes the answer tag of the question before it': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.equal(await page.ev(`${bubble('push the branch')}.querySelector('.answer.yes').textContent`), '✓ You: yes');
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .bubble.user')].some(b => b.textContent.trim() === 'yes')`), false, 'no bubble of its own');
    },

    '"Show earlier" loads 60 more items above, keeping the view where it was': async ({ page, open, answerPosts }) => {
        const say = (text, n) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 10, 14, 10, n)).toISOString(), message: { content: [{ type: 'text', text }] } });
        const turn = { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } };
        const entries = Array.from({ length: 70 }, (_, n) => [turn, say(`message ${n}`, n)]).flat();
        const asked = [];
        await open();
        await ready(page);
        page.route = q => {
            if (!q.url.includes('/api/transcript')) {
                return answerPosts(q);
            }
            const max = Number(new URL(q.url).searchParams.get('max'));
            asked.push(max);
            const { items, earlier } = chatFeed(entries, max);
            return { status: 200, body: JSON.stringify({ items, more: earlier > 0, working: false, asking: null }), headers: { 'content-type': 'application/json' } };
        };
        await page.waitFor(`${bubble('message 69')} && document.querySelector('#feed').firstElementChild.matches('.c-earlier')`, { what: 'the newest 60 under a Show earlier line' });
        assert.equal(await page.ev(`!!${bubble('message 9')}`), false, 'the 61st newest is not loaded');
        assert.equal(asked.at(-1), 60);
        await page.click('#feed .c-earlier button');
        await page.waitFor(`${bubble('message 0')}`, { what: 'the earlier items' });
        assert.equal(asked.at(-1), 120);
        assert.equal(await page.ev(`!!document.querySelector('#feed .c-earlier')`), false, 'nothing earlier left');
        const box = `document.getElementById('feed').getBoundingClientRect()`;
        assert.ok(await page.ev(`${bubble('message 0')}.getBoundingClientRect().bottom <= ${box}.top + 1`), 'the loaded items sit above the view');
        assert.ok(await page.ev(`(() => { const t = ${bubble('message 10')}.getBoundingClientRect().top; return t >= ${box}.top - 30 && t < ${box}.bottom; })()`), 'the view stays at what was the top');
    },

    'a New divider marks what came since you left, until you scroll back to the bottom': async ({ page, open, IDS, answerPosts }) => {
        const say = (text, n) => ({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 10, 14, 10, n)).toISOString(), message: { content: [{ type: 'text', text }] } });
        const turn = { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } };
        const { items } = chatFeed(Array.from({ length: 40 }, (_, n) => [turn, say(`message ${n}`, n)]).flat());
        const key = `last-seen:${IDS.master}`;
        await open({ [key]: String(Date.UTC(2026, 10, 14, 10, 35, 30)) });
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        await page.waitFor(`${bubble('message 39')}`, { what: 'the routed feed' });
        await page.waitFor(`document.querySelector('#feed .c-new')?.nextElementSibling === ${bubble('message 36')}`, { what: 'the New divider above the first later item' });
        assert.equal(await page.ev(`document.querySelectorAll('#feed .c-new').length`), 1);
        assert.equal(await page.ev(`document.querySelector('#feed .c-new').matches('.tools.compact') && document.querySelector('#feed .c-new').textContent`), 'New');
        await page.ev(`document.getElementById('feed').scrollTop = 0`);
        await page.ev(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        assert.ok(await page.ev(`!!document.querySelector('#feed .c-new')`), 'scrolling up keeps it');
        await page.ev(`document.getElementById('feed').scrollTop = document.getElementById('feed').scrollHeight`);
        await page.waitFor(`!document.querySelector('#feed .c-new') && localStorage.getItem(${JSON.stringify(key)}) === ''`, { what: 'the divider to clear at the bottom' });
        await page.ev(`window.dispatchEvent(new Event('blur'))`);
        assert.ok(Number(await page.ev(`localStorage.getItem(${JSON.stringify(key)})`)) > Date.now() - 60_000, 'leaving marks the time');
        await page.ev(`window.dispatchEvent(new Event('focus'))`);
    },

    'an API error shows as a line in the feed': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.equal(await page.ev(`document.querySelector('#feed .tools.api-error').textContent`), 'API Error: 529 Overloaded · please retry');
    },

    'an open decision stays pinned above the composer after the user says something else, and its strip jumps to the reply': async ({ page, open, IDS, answerPosts }) => {
        const say = (text, at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
        const items = chatItems([
            say('**▸ Cache layer**\n\n**Options**\n1. **Redis** — shared\n2. **In-memory** — simplest\n\n**In flight**\n- Waiting on you: which cache\n\n**TLDR:** Which cache should I build?', '2026-11-14T10:00:00.000Z'),
            { type: 'user', timestamp: '2026-11-14T10:01:00.000Z', message: { content: 'also fix the README typo' } },
            say('**▸ Cache layer**\n\nFixed the typo.\n\n**Options**\n1. **Redis** — shared\n2. **In-memory** — simplest\n\n**In flight**\n- Nothing running\n- Waiting on you: which cache, Redis or in-memory\n\n**Heads-up:** Redis needs a server\n\n**TLDR:** Typo fixed.', '2026-11-14T10:02:00.000Z')
        ]);
        await open();
        await ready(page);
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        await page.waitFor(`!document.getElementById('wait').hidden`, { what: 'the pinned strip' });
        assert.equal(await page.ev(`document.getElementById('wait-q').textContent`), 'which cache, Redis or in-memory');
        assert.equal(await page.ev(`${bubble('Typo fixed')}.querySelector('.b-heads').textContent`), 'Heads-up: Redis needs a server', 'the Heads-up line outside the fold');
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#wait-opts wa-button')].map(b => b.firstChild.textContent)`), ['Redis', 'In-memory']);
        await page.waitFor(`document.getElementById('status-text').textContent.startsWith('Claude needs your answer')`, { what: 'the status from the open decision' });
        await page.ev(`document.getElementById('feed').scrollTop = 0`);
        await page.click('#wait-q');
        await page.waitFor(`document.activeElement === ${bubble('Typo fixed')}`, { what: 'the strip to focus the reply it is about' });
        await page.click('#wait-opts wa-button:first-child');
        await page.waitFor(`document.getElementById('wait').hidden`, { what: 'the strip to go once answered' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'Redis']]);
    },

    'three replies waiting on the same thing: only the newest needs you, older ones stay quiet, the strip shows question, context and chips': async ({ page, open, answerPosts }) => {
        const say = (text, at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
        const turn = { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } };
        const W = "**Waiting on you:** #2281, naming the rule's supplier — you wanted to clarify something — what do you want to clarify? — (1) how the supplier name is read: a database lookup (recommended); (2) the tooltip text; (3) something else.";
        const HU = '**Heads-up:** five MRs need force-pushes.';
        const items = chatItems([
            say(`**▸ Agents waiting · needs you**\n\n${HU}\n\n${W}\n\n**TLDR:** First check-in.`, '2026-11-20T11:51:00.000Z'), turn,
            say(`**▸ Polish done · needs you**\n\n${HU}\n\nAdded tests for three things:\n\n- the duplicate dialog comes first\n- cancelling the dialog skips payment\n\n${W}\n\n**TLDR:** Polish done.`, '2026-11-20T11:52:00.000Z'), turn,
            say(`**▸ Agents waiting · needs you**\n\n${HU}\n\n${W}\n\n**TLDR:** Second check-in.`, '2026-11-20T11:53:00.000Z')
        ]);
        await open();
        await ready(page);
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        await page.waitFor(`!document.getElementById('wait').hidden && ${bubble('Second check-in')}`, { what: 'the strip and the newest reply' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .bubble.needs')].map(b => b.textContent.includes('Second check-in'))`), [true], 'only the newest reply needs you');
        assert.equal(await page.ev(`document.querySelectorAll('#feed .need-pill').length`), 1);
        assert.equal(await page.ev(`document.querySelectorAll('#feed .b-heads').length`), 1, 'the Heads-up shows on the newest reply only');
        assert.ok(await page.ev(`${bubble('Polish done')}.querySelector('.body').textContent.includes('five MRs need force-pushes')`), 'an older Heads-up sits in its fold');
        assert.equal(await page.ev(`document.querySelectorAll('#feed .replies').length`), 0, 'no chips in the feed: the strip has them, and a plain list is not a choice');
        assert.equal(await page.ev(`document.getElementById('wait-q').textContent`), 'what do you want to clarify?');
        assert.equal(await page.ev(`document.getElementById('wait-ctx').textContent`), "#2281, naming the rule's supplier — you wanted to clarify something");
        assert.ok(await page.ev(`document.getElementById('wait-ctx').classList.contains('clamp')`), 'the context is clamped');
        await page.click('#wait-ctx');
        assert.ok(await page.ev(`!document.getElementById('wait-ctx').classList.contains('clamp')`), 'a click shows it all');
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#wait-opts wa-button')].map(b => b.firstChild.textContent)`), ['how the supplier name is read', 'the tooltip text', 'something else']);
        assert.ok(await page.ev(`document.querySelector('#wait-opts wa-button').classList.contains('primary')`), 'the recommended option stands out');
        await page.click('#wait-opts wa-button:last-child');
        await page.waitFor(`document.getElementById('wait').hidden`, { what: 'the strip to go once answered' });
        assert.deepEqual(page.posts.map(p => p.body), ['something else']);
    },

    'a slow transcript response that lands after a newer one does not roll the feed back': async ({ page, open, IDS, touchSession, homebase }) => restored(join(dirname(homebase), 'home', '.claude', 'projects', '-fx-alpha', `${IDS.master}.jsonl`), async () => {
        await open();
        await page.waitFor(feedHas('tag the release'), { what: 'the chat' });
        // hold the next transcript response 4s in the page, as a slow poll would
        await page.ev(`(() => {
            const f = window.fetch;
            window.__hold = true;
            window.fetch = async (...a) => {
                const r = await f(...a);
                if (String(a[0]).startsWith('/api/transcript') && window.__hold) {
                    window.__hold = false;
                    await new Promise(ok => setTimeout(ok, 4000));
                }
                return r;
            };
        })()`);
        await page.ev(`import('/chat.js').then(m => { m.refreshChat(); })`); // A: old data, held
        await sleep(300);
        touchSession('alpha', IDS.master, 'FRESH-REPLY-R1');
        await page.ev(`import('/chat.js').then(m => m.refreshChat())`); // B: fresh
        await page.waitFor(feedHas('FRESH-REPLY-R1'), { what: 'the fresh reply' });
        await page.ev(`(() => { window.__lost = false; const t = setInterval(() => { if (!${feedHas('FRESH-REPLY-R1')}) { window.__lost = true; clearInterval(t); } }, 20); })()`);
        await sleep(4500);
        assert.equal(await page.ev('window.__lost'), false, 'the fresh reply vanished when the held (older) response rendered');
    }),

    'reading scrolled up: a new reply at the bottom does not shift what you read': async ({ page, open, IDS, homebase }) => {
        const home = join(dirname(homebase), 'home');
        const file = join(home, '.claude', 'projects', '-fx-gamma', `${IDS.gamma}.jsonl`);
        await restored(file, async () => {
            const base = { isSidechain: false, cwd: join(home, 'repos', 'gamma'), sessionId: IDS.gamma, version: '2.1.322', gitBranch: 'main' };
            const at = s => new Date(Date.now() - s * 1000).toISOString();
            const lines = [];
            for (let k = 0; k < 80; k++) {
                const s = 900 - k * 10;
                lines.push({ ...base, type: 'user', uuid: `ru${k}`, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: `question ${k}` } });
                lines.push({ ...base, type: 'assistant', uuid: `ra${k}`, timestamp: at(s - 5), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply ${k}\n\nline two of reply ${k}` }] } });
                lines.push({ ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(s - 6) });
            }
            appendFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
            await open({ project: 'gamma', chat: IDS.gamma });
            await page.waitFor(feedHas('reply 79'), { what: 'the long chat' });
            await page.ev(`(() => { const f = document.getElementById('feed'); f.scrollTop = f.scrollHeight / 2; })()`);
            await sleep(500);
            const probe = `(() => { const f = document.getElementById('feed'), top = f.getBoundingClientRect().top; const b = [...f.querySelectorAll('.bubble')].find(b => b.getBoundingClientRect().bottom > top + 5); return { text: b.textContent.slice(0, 30), y: Math.round(b.getBoundingClientRect().top - top) }; })()`;
            const before = await page.ev(probe);
            const s = 0;
            appendFileSync(file, [
                { ...base, type: 'user', uuid: 'rux', timestamp: at(s + 2), origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'question x' } },
                { ...base, type: 'assistant', uuid: 'rax', timestamp: at(s + 1), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'reply x' }] } },
                { ...base, type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(s) }
            ].map(l => JSON.stringify(l)).join('\n') + '\n');
            await page.waitFor(feedHas('reply x'), { what: 'the new reply', timeout: 8000 });
            await sleep(300);
            const after = await page.ev(probe);
            assert.deepEqual(after, before, 'the item the user was reading moved');
        });
    },

    'at the bottom: a thumbnail loading, a new reply and a shorter feed all keep the newest in view': async ctx => withImageChat(ctx, async (add, fromBottom) => {
        const { page } = ctx;
        assert.ok(await page.ev(fromBottom) < 40, `the thumbnail that loaded after the chat opened pushed the newest out of view: ${await page.ev(fromBottom)}px from the end`);
        for (const n of [30, 31]) {
            await add(n);
            assert.ok(await page.ev(fromBottom) < 40, `reply ${n} left the feed ${await page.ev(fromBottom)}px from the end`);
        }
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 600, deviceScaleFactor: 1, mobile: false });
        try {
            await sleep(300);
            assert.ok(await page.ev(fromBottom) < 40, `a shorter feed left it ${await page.ev(fromBottom)}px from the end`);
        } finally {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        }
    }),

    'reloading the page with a chat open lands on its newest message (big screenshots in the last screenful)': async ctx => withImageChat(ctx, async (add, fromBottom) => {
        const { page } = ctx;
        for (let round = 0; round < 3; round++) {
            await page.cmd('Page.reload', {});
            await add(30 + round); // a reply lands while the page is still loading
            assert.ok(await page.ev(fromBottom) < 40, `reload ${round + 1} left the feed ${await page.ev(fromBottom)}px from the end`);
        }
    }, { 21: true, 22: true, 23: true, 24: true })
};
