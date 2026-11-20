import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

// Feed geometry that must not change while only the status line or the input changes.
const geometry = `(() => { const f = document.getElementById('feed'); return { scrollTop: f.scrollTop, clientHeight: f.clientHeight, scrollHeight: f.scrollHeight, bottom: f.getBoundingClientRect().bottom, dock: document.getElementById('send').offsetHeight }; })()`;

export default {
    'the upload button sits inside the field box, and the composer has no border': async ({ page, open }) => {
        await open();
        const r = await page.ev(`(() => { const box = document.querySelector('.c-row').getBoundingClientRect(), inside = id => { const b = document.getElementById(id).getBoundingClientRect(); return b.left >= box.left && b.right <= box.right && b.top >= box.top && b.bottom <= box.bottom; }; return { attach: inside('attach-btn'), row: getComputedStyle(document.querySelector('.c-row')).borderTopWidth, composer: getComputedStyle(document.querySelector('.composer')).borderTopWidth }; })()`);
        assert.deepEqual(r, { attach: true, row: '1px', composer: '0px' });
    },

    'the upload button stays centered on the first line at 1, 3 and 8 lines, at desktop and phone width': async ({ page, open }) => {
        await open();
        for (const [w, mobile] of [[1440, false], [390, true]]) {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile });
            for (const lines of [1, 3, 8]) {
                await page.ev(`document.getElementById('msg').value = ${JSON.stringify(Array(lines).fill('x').join('\n'))}`);
                const d = await page.ev(`(async () => { const m = document.getElementById('msg'); await m.updateComplete; const t = m.shadowRoot.querySelector('textarea'), lh = parseFloat(getComputedStyle(t).lineHeight), pad = parseFloat(getComputedStyle(t).paddingTop), tb = t.getBoundingClientRect(), ab = document.getElementById('attach-btn').getBoundingClientRect(); return Math.abs((ab.top + ab.bottom) / 2 - (tb.top + pad + lh / 2)); })()`);
                assert.ok(d <= 2, `attach icon is ${d}px off the first line with ${lines} lines at ${w}px`);
            }
            await page.ev(`document.getElementById('msg').value = ''`);
        }
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    },

    'the + button opens a menu with Add files…, and Esc closes it': async ({ page, open }) => {
        await open();
        await page.click('#attach-btn');
        await page.waitFor(`document.getElementById('plus-menu').open`, { what: 'the + menu' });
        assert.equal(await page.ev(`document.querySelector('#plus-menu wa-dropdown-item').textContent`), 'Add files…');
        await page.key('Escape');
        await page.waitFor(`!document.getElementById('plus-menu').open`, { what: 'Esc to close it' });
    },

    'sending: the POST is intercepted, the outbox bubble shows and the input clears': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        await page.click('#msg');
        await page.type('hello from the browser test');
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user:last-of-type')?.textContent.includes('hello from the browser test')`, { what: 'the outbox bubble' });
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .bubble.user')].at(-1).querySelector('.b-note').textContent`), 'sending…');
        assert.equal(await page.ev(`document.getElementById('msg').value`), '');
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'hello from the browser test']]);
        assert.equal(await page.ev(`(() => { const f = document.getElementById('feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 40; })()`), true, 'scrolled to the new bubble');
    },

    'a send the transcript never shows stays as not confirmed, with Retry and Dismiss': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        await page.click('#msg');
        await page.type('never lands');
        await page.key('Enter');
        const mine = `[...document.querySelectorAll('#feed .bubble.user')].find(b => b.textContent.includes('never lands'))`;
        await page.waitFor(`${mine}?.querySelector('.b-note').textContent === 'sending…'`, { what: 'the outbox bubble' });
        await page.ev(`(() => { const now = Date.now; Date.now = () => now() + 31_000; })()`); // past OUTBOX_TTL_MS
        await page.waitFor(`${mine}?.querySelector('.b-note').textContent.startsWith('Not confirmed — Claude may not have received this')`, { what: 'the not confirmed note' });
        await page.clickOn(`${mine}.querySelector('wa-button.retry')`);
        await page.waitFor(`${mine}?.querySelector('.b-note').textContent === 'sending…'`, { what: 'the retried bubble' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'never lands'], [`/api/send?id=${IDS.master}`, 'never lands']]);
        await page.ev(`(() => { const now = Date.now; Date.now = () => now() + 31_000; })()`);
        await page.waitFor(`${mine}?.querySelector('wa-button.dismiss')`, { what: 'not confirmed again' });
        await page.clickOn(`${mine}.querySelector('wa-button.dismiss')`);
        await page.waitFor(`!${mine}`, { what: 'the dismissed bubble to go' });
        assert.equal(page.posts.length, 2, 'dismiss sends nothing');
    },

    'a double tap on a quick-reply chip sends once': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelectorAll('#feed .replies wa-button').length`, { what: 'the quick-reply chips' });
        await page.ev(`(() => { const b = document.querySelector('#feed .replies wa-button'); b.click(); setTimeout(() => b.click(), 60); })()`);
        await sleep(1500);
        assert.equal(page.posts.filter(p => p.url.includes('/api/send')).length, 1);
    },

    'the draft and the error line follow the chat: a focused chat starts empty, and going back restores the draft': async ({ page, open, IDS }) => {
        const asker = `#masters tr[data-key="asking:${IDS.asker}"]`;
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${asker}')`, { what: "the asker's row" });
        await page.click('#msg');
        await page.type('draft for main');
        await page.ev(`document.getElementById('c-err').textContent = 'Claude is busy'`);
        await page.click(asker);
        await page.waitFor(`!document.getElementById('c-back').hidden`, { what: 'the focused chat' });
        assert.deepEqual(await page.ev(`[document.getElementById('msg').value, document.getElementById('c-err').textContent]`), ['', '']);
        await page.click('#msg');
        await page.type('draft for asker');
        await page.click('#c-back');
        await page.waitFor(`document.getElementById('c-back').hidden`, { what: 'the main chat' });
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'draft for main');
        await page.waitFor(`document.querySelector('${asker}')`, { what: "the asker's row" });
        await page.click(asker);
        await page.waitFor(`document.getElementById('msg').value === 'draft for asker'`, { what: "the asker's draft" });
    },

    'a failed send marks the bubble, shows the error and gives the text back': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        page.route = q => (q.url.includes('/api/send') ? { status: 500, body: 'tmux down' } : answerPosts(q));
        await page.click('#msg');
        await page.type('this one fails');
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user.failed')`, { what: 'the failed bubble' });
        assert.equal(await page.ev(`document.querySelector('#feed .bubble.user.failed .b-note').textContent`), 'Not sent RetryDismiss');
        assert.equal(await page.ev(`document.getElementById('c-err').textContent`), 'tmux down');
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'this one fails');
        // the next send drops the failed bubble
        page.route = answerPosts;
        await page.key('Enter');
        await page.waitFor(`!document.querySelector('#feed .bubble.user.failed')`, { what: 'the failed bubble to go' });
        assert.equal(await page.ev(`document.getElementById('c-err').textContent`), '');
    },

    'a Not sent bubble has Retry and Dismiss': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        page.route = q => (q.url.includes('/api/send') ? { status: 500, body: 'tmux down' } : answerPosts(q));
        await page.click('#msg');
        await page.type('retry me');
        await page.key('Enter');
        const failed = `document.querySelector('#feed .bubble.user.failed')`;
        await page.waitFor(`${failed}?.querySelector('wa-button.retry') && ${failed}.querySelector('wa-button.dismiss')`, { what: 'Retry and Dismiss on the failed bubble' });
        await page.clickOn(`${failed}.querySelector('wa-button.dismiss')`);
        await page.waitFor(`!${failed}`, { what: 'the dismissed bubble to go' });
        await page.ev(`document.getElementById('msg').value = ''`);
        await page.click('#msg');
        await page.type('second try');
        await page.key('Enter');
        await page.waitFor(`${failed}?.querySelector('wa-button.retry')`, { what: 'the failed bubble' });
        page.route = answerPosts;
        await page.clickOn(`${failed}.querySelector('wa-button.retry')`);
        await page.waitFor(`!${failed}`, { what: 'the retried bubble' });
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')).map(p => p.body), ['retry me', 'second try', 'second try']);
    },

    'a refused send (409) says why on the bubble and offers Dismiss, not a Retry that would only be refused again': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        const why = "Claude is asking something Homebase can't see: answer it in the terminal";
        page.route = q => (q.url.includes('/api/send') ? { status: 409, body: why } : answerPosts(q));
        await page.click('#msg');
        await page.type('refused one');
        await page.key('Enter');
        const failed = `document.querySelector('#feed .bubble.user.failed')`;
        await page.waitFor(`${failed}?.querySelector('wa-button.dismiss')`, { what: 'the refused bubble' });
        assert.equal(await page.ev(`${failed}.querySelector('.b-note').firstChild.textContent`), `Not sent: ${why}`);
        assert.equal(await page.ev(`!!${failed}.querySelector('wa-button.retry')`), false);
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'refused one', 'the text is back to send once the reason is dealt with');
    },

    'an attached image is uploaded and sent as an [Image: path] line, with a thumbnail': async ({ page, open, answerPosts, homebase }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        page.route = q => (q.url.includes('/api/upload') ? null : answerPosts(q)); // the upload reaches the server
        // a 1x1 PNG, attached as the file picker would
        await page.ev(`(() => { const b = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='); const dt = new DataTransfer();
            dt.items.add(new File([Uint8Array.from(b, c => c.charCodeAt(0))], 'dot.png', { type: 'image/png' }));
            const i = document.getElementById('attach-input'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
        await page.waitFor(`document.querySelector('#attached .c-thumb img')?.src.startsWith('data:image/png')`, { what: 'the pending thumbnail' });
        await page.click('#msg');
        await page.type('what is this?');
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user:last-of-type .b-images img')?.src.startsWith('data:image/png')`, { what: 'the thumbnail in the sent bubble' });
        const send = page.posts.find(p => p.url.includes('/api/send'));
        const m = /^what is this\?\n\[Image: (\/.+\/uploads\/[0-9a-f-]{36}\.png)\]$/.exec(send.body);
        assert.ok(m, send.body);
        assert.ok(m[1].startsWith(`${homebase}/uploads/`), m[1]);
        assert.equal(await page.ev(`document.getElementById('attached').hidden`), true, 'attachments cleared');
        // the bubble shows the picture and the text, never the path
        for (const [w, mobile] of [[1440, false], [390, true]]) {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile });
            await sleep(100);
            const r = await page.ev(`(() => { const b = document.querySelector('#feed .bubble.user:last-of-type'); return { img: !!b.querySelector('img'), text: b.querySelector('.body')?.textContent.trim(), path: /uploads|\\[Image/.test(b.textContent), sideScroll: document.documentElement.scrollWidth > innerWidth }; })()`);
            assert.deepEqual(r, { img: true, text: 'what is this?', path: false, sideScroll: false }, `at ${w}px ${JSON.stringify(r)}`);
            if (w === 390) {
                await page.ev(`document.querySelector('#feed .bubble.user:last-of-type .b-images img').click()`);
                await page.waitFor(`document.querySelector('.lightbox img')?.src.startsWith('data:image/png')`, { what: 'the lightbox' });
                const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
                (await import('node:fs')).writeFileSync('/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad/image-bubble.png', Buffer.from(shot.data, 'base64'));
                await page.key('Escape');
                await page.waitFor(`!document.querySelector('.lightbox')`, { what: 'the lightbox closed' });
            }
        }
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    },

    'pasted images get their own row: thumbnails, status line and the last feed item never overlap, at desktop and phone width': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        await page.ev(`(() => { const b = atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='); const dt = new DataTransfer();
            for (let n = 0; n < 9; n++) dt.items.add(new File([Uint8Array.from(b, c => c.charCodeAt(0))], 'dot' + n + '.png', { type: 'image/png' }));
            const i = document.getElementById('attach-input'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
        await page.waitFor(`document.querySelectorAll('#attached .c-thumb').length === 9`, { what: 'nine thumbnails' });
        for (const [w, mobile] of [[1440, false], [390, true]]) {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile });
            await sleep(100);
            const r = await page.ev(`(() => { const R = s => document.querySelector(s).getBoundingClientRect(), items = document.getElementById('feed').children, last = items[items.length - 1].getBoundingClientRect(), th = R('#attached'), st = R('#status'), row = R('.c-row'), f = R('#feed');
                return { statusBelowFeedItem: st.top >= last.bottom - 1, thumbsBelowStatus: th.top >= st.bottom - 1, rowBelowThumbs: row.top >= th.bottom - 1, feedAboveDock: f.bottom <= st.top + 1, sideScroll: document.documentElement.scrollWidth > innerWidth }; })()`);
            assert.deepEqual(r, { statusBelowFeedItem: true, thumbsBelowStatus: true, rowBelowThumbs: true, feedAboveDock: true, sideScroll: false }, `at ${w}px`);
            const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
            (await import('node:fs')).writeFileSync(`/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad/paste-${w}.png`, Buffer.from(shot.data, 'base64'));
        }
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    },

    'the feed does not jump when the status changes or while typing': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        // make the feed scrollable and park it mid-way, as a reader scrolled up would
        await page.ev(`(() => { const f = document.getElementById('feed'); for (let i = 0; i < 40; i++) { const b = document.createElement('div'); b.className = 'bubble assistant'; b.textContent = 'filler ' + i; f.prepend(b); } f.scrollTop = (f.scrollHeight - f.clientHeight) / 2; })()`);
        const before = await page.ev(geometry);
        assert.ok(before.scrollTop > 100, 'feed scrolled mid-way');
        const statuses = [['working', 'Claude is working… · 3m'], ['asking', 'Claude is asking — see the question above'], ['error', 'Can’t reach Homebase — reconnecting…'],
            ['working', `Claude is working… ${'and a very long status line that must ellipsize, not wrap '.repeat(3)}`], ['idle', 'Claude is done — your turn']];
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
    },
    'a long paste shows as [Pasted text #n +L lines] and is sent in full': async ({ page, open, answerPosts, IDS }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        page.route = answerPosts;
        await page.click('#msg');
        await page.type('look: ');
        const long = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\\n');
        await page.ev(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', '${long}');
            document.getElementById('msg').input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, composed: true })); })()`);
        await page.waitFor(`/look: \\[Pasted text #\\d+ \\+12 lines\\]$/.test(document.getElementById('msg').value)`, { what: 'the paste label' });
        await page.key('Enter');
        await page.waitFor(`document.querySelector('#feed .bubble.user:last-of-type')?.textContent.includes('row 11')`, { what: 'the full text in the bubble' });
        const send = page.posts.find(p => p.url.includes(`/api/send?id=${IDS.master}`));
        assert.equal(send.body, 'look: ' + Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n'));
    }
};
