import assert from 'node:assert/strict';
import { chatItems, chatFeed } from '../../server.mjs';

const bubble = text => `[...document.querySelectorAll('#feed .bubble')].find(b => b.textContent.includes(${JSON.stringify(text)}))`;
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

    'topic header and needs-you styling': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .b-topic-name')].map(t => t.textContent)`), ['Fix login', 'Release'], 'a header only where the topic changes');
        assert.ok(await page.ev(`${bubble('tag the release')}.matches('.bubble.assistant.needs.topical') && ${bubble('tag the release')}.querySelector('.need-pill').textContent === 'needs you'`));
        assert.ok(await page.ev(`${bubble('cookie scope')}.matches('.fyi') && !${bubble('cookie scope')}.querySelector('.need-pill')`), 'a question the user has replied to no longer needs them');
        assert.ok(await page.ev(`${bubble('push the branch')}.matches('.fyi')`), 'a plain reply is FYI');
        assert.ok(await page.ev(`getComputedStyle(${bubble('tag the release')}, '::before').width === '4px'`), 'the amber strip');
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

    'the header and the input name the bound project, a long title truncated at the same header height': async ({ page, open }) => {
        await open();
        await ready(page);
        await page.waitFor(`document.getElementById('c-title').textContent === 'alpha · Release'`, { what: 'the project and topic in the header' });
        assert.equal(await page.ev(`document.getElementById('msg').getAttribute('placeholder')`), 'Message Claude in alpha…');
        const height = `document.querySelector('#chat .c-head').getBoundingClientRect().height`, h = await page.ev(height);
        await page.ev(`document.getElementById('c-title').textContent = 'alpha · ' + 'a very long topic '.repeat(20)`);
        assert.equal(await page.ev(height), h, 'header height unchanged');
        assert.ok(await page.ev(`(() => { const t = document.getElementById('c-title'); return t.scrollWidth > t.clientWidth && getComputedStyle(t).textOverflow === 'ellipsis'; })()`), 'truncated with an ellipsis');
        assert.ok(await page.ev(`document.querySelector('#c-menu button[slot="trigger"]').getBoundingClientRect().right <= document.getElementById('chat').getBoundingClientRect().right`), 'the menu stays in view');
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
            return { status: 200, body: JSON.stringify({ items, earlier, working: false, asking: null }), headers: { 'content-type': 'application/json' } };
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

    'an API error shows as a red line': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.equal(await page.ev(`document.querySelector('#feed .tools.api-error').textContent`), 'API Error: 529 Overloaded · please retry');
        const [r, g, b] = (await page.ev(`getComputedStyle(document.querySelector('#feed .api-error')).color`)).match(/\d+/g).map(Number);
        assert.ok(r > 150 && g < 100 && b < 100, `red, got rgb(${r}, ${g}, ${b})`);
    }
};
