import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

// Feed geometry that must not change while only the status line or the input changes.
const geometry = `(() => { const f = document.getElementById('feed'); return { scrollTop: f.scrollTop, clientHeight: f.clientHeight, scrollHeight: f.scrollHeight, bottom: f.getBoundingClientRect().bottom, dock: document.getElementById('send').offsetHeight }; })()`;

export default {
    'sending: the POST is intercepted, the outbox bubble shows and the input clears': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        await page.click('#msg');
        await page.type('hello from the browser test');
        await page.waitFor(`!document.getElementById('send-btn').disabled`, { what: 'the send button to enable' });
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user:last-of-type')?.textContent.includes('hello from the browser test')`, { what: 'the outbox bubble' });
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .bubble.user')].at(-1).querySelector('.b-note').textContent`), 'sending…');
        assert.equal(await page.ev(`document.getElementById('msg').value`), '');
        assert.equal(await page.ev(`document.getElementById('send-btn').disabled`), true);
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'hello from the browser test']]);
        assert.equal(await page.ev(`(() => { const f = document.getElementById('feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 40; })()`), true, 'scrolled to the new bubble');
    },

    'a failed send marks the bubble, shows the error and gives the text back': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        page.route = q => (q.url.includes('/api/send') ? { status: 500, body: 'tmux down' } : answerPosts(q));
        await page.click('#msg');
        await page.type('this one fails');
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user.failed')`, { what: 'the failed bubble' });
        assert.equal(await page.ev(`document.querySelector('#feed .bubble.user.failed .b-note').textContent`), 'Not sent');
        assert.equal(await page.ev(`document.getElementById('c-err').textContent`), 'tmux down');
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'this one fails');
        // the next send drops the failed bubble
        page.route = answerPosts;
        await page.key('Enter');
        await page.waitFor(`!document.querySelector('#feed .bubble.user.failed')`, { what: 'the failed bubble to go' });
        assert.equal(await page.ev(`document.getElementById('c-err').textContent`), '');
    },

    'the feed does not jump when the status changes or while typing': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        // make the feed scrollable and park it mid-way, as a reader scrolled up would
        await page.ev(`(() => { const f = document.getElementById('feed'); for (let i = 0; i < 40; i++) { const b = document.createElement('div'); b.className = 'bubble assistant'; b.textContent = 'filler ' + i; f.prepend(b); } f.scrollTop = (f.scrollHeight - f.clientHeight) / 2; })()`);
        const before = await page.ev(geometry);
        assert.ok(before.scrollTop > 100, 'feed scrolled mid-way');
        const statuses = [['working', 'Claude is working… · 3m'], ['asking', 'Claude is asking — answer below'], ['error', 'Can’t reach Homebase — reconnecting…'],
            ['working', `Claude is working… ${'and a very long status line that must ellipsize, not wrap '.repeat(3)}`], ['idle', 'Idle — waiting for you']];
        for (const [kind, text] of statuses) {
            await page.ev(`document.getElementById('status').className = 'c-status ${kind}'; document.getElementById('status-text').textContent = ${JSON.stringify(text)}`);
            await sleep(100);
            assert.deepEqual(await page.ev(geometry), before, `status ${kind}`);
        }
        await page.click('#msg');
        for (let n = 1; n <= 8; n++) {
            await page.type(n === 1 ? 'line 1' : `\nline ${n}`);
            await sleep(80);
            assert.deepEqual(await page.ev(geometry), before, `typing ${n} lines`);
        }
        assert.ok(await page.ev(`document.getElementById('msg').value.split('\\n').length === 8`));
    }
};
