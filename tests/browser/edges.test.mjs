// Things going wrong around the page: server errors, odd replies, slow sends.
import assert from 'node:assert/strict';

const loaded = `document.getElementById('feed').textContent.includes('tag the release')`;

export default {
    'a server error is told apart from being offline': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(loaded, { what: 'the chat' });
        const flags = `['disconnected', 'server-error'].map(c => document.body.classList.contains(c)).join()`;
        page.route = q => (q.url.includes('/api/sessions') ? { status: 500, body: 'boom' } : answerPosts(q));
        await page.waitFor(`${flags} === 'true,true'`, { what: 'the server error state' });
        const said = await page.ev(`document.getElementById('offline').textContent`);
        page.route = q => (q.url.includes('/api/sessions') ? { status: 401, body: '' } : answerPosts(q));
        await page.waitFor(`${flags} === 'true,false'`, { what: 'the offline state' });
        assert.notEqual(await page.ev(`document.getElementById('offline').textContent`), said, 'the header says which');
        page.route = answerPosts;
        await page.waitFor(`${flags} === 'false,false'`, { what: 'online again' });
    },

    'a reply that fails to render shows as plain text, and the rest of the feed stays': async ({ page, open, answerPosts }) => {
        const at = n => new Date(Date.now() - (9 - n) * 60_000).toISOString();
        const feedOf = items => q => (q.url.includes('/api/transcript') ? { body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        const texts = `[...document.querySelectorAll('#feed .bubble')].map(b => b.textContent).join('|')`;
        await open();
        // an inline SVG link: its <a> has a read-only target
        page.route = feedOf([
            { role: 'assistant', id: 'a1', at: at(1), text: 'svg-reply <svg><a href="https://example.com/"><text>svg-link</text></a></svg>' },
            { role: 'user', text: 'next', at: at(1.5) },
            { role: 'assistant', id: 'a2', at: at(2), text: 'reply after the svg' }
        ]);
        await page.waitFor(`${texts}.includes('reply after the svg')`, { what: 'the feed with an SVG link' });
        assert.ok((await page.ev(texts)).includes('svg-reply'), 'the SVG reply is there too');
        // an item no renderer expects
        page.route = feedOf([
            { role: 'assistant', id: 'b1', at: at(3), text: { odd: 'shape' }, tldr: 7 },
            { role: 'user', text: 'next', at: at(3.5) },
            { role: 'assistant', id: 'b2', at: at(4), text: 'reply after the odd one' }
        ]);
        await page.waitFor(`${texts}.includes('reply after the odd one')`, { what: 'the feed with an odd item' });
        assert.equal(await page.ev(`document.querySelectorAll('#feed .bubble.assistant').length`), 2, 'the odd item keeps its place');
        assert.ok((await page.ev(texts)).includes('shape'), 'with its text');
    },

    'a chat whose turn died keeps a row on the board until it is opened': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        await page.waitFor(`document.querySelector('#masters tr')`, { what: 'the board' });
        const row = `document.querySelector('#masters tr[data-key="died:${IDS.other}"]')`;
        assert.equal(await page.ev(`!!${row}`), false, 'no row while nothing died');
        await page.ev(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o); if (!String(u).startsWith('/api/sessions')) return r; const list = await r.json(); for (const s of list) { if (s.id === ${JSON.stringify(IDS.other)}) { s.died = true; s.status = 'idle'; s.title = 'مرحبا שלום'; } } return new Response(JSON.stringify(list), { status: 200 }); }; })()`);
        await page.waitFor(`!!${row}`, { what: 'the row of the died turn' });
        assert.equal(await page.ev(`${row}.querySelector('b bdi')?.textContent`), 'مرحبا שלום', 'a right-to-left title is isolated from the labels around it');
        await page.clickOn(row);
        await page.waitFor(`!${row}`, { what: 'the row gone once looked at' });
        await page.waitFor(`document.getElementById('feed').textContent.includes('The cache is fine')`, { what: 'and its chat open' }); // the feed island draws a tick later
    },

    'a send Homebase never answered is not confirmed, and Retry sends no second copy once the first arrived': async ({ page, open }) => {
        await open();
        await page.waitFor(loaded, { what: 'the chat' });
        // the send times out in the page; once window.landed is set, the transcript shows the message after all
        await page.ev(`(() => { window.sends = 0; const f = window.fetch; window.fetch = async (u, o) => {
            if (String(u).startsWith('/api/send')) { window.sends++; throw new DOMException('signal timed out', 'TimeoutError'); }
            const r = await f(u, o);
            if (!String(u).startsWith('/api/transcript') || !window.landed) return r;
            const d = await r.json();
            d.items.push({ role: 'user', text: 'slow but delivered', at: new Date().toISOString() });
            return new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
        }; })()`);
        await page.click('#msg');
        await page.type('slow but delivered');
        await page.key('Enter');
        const mine = `[...document.querySelectorAll('#feed .bubble.user')].find(b => b.textContent.includes('slow but delivered'))`;
        await page.waitFor(`!!${mine}?.querySelector('wa-button.retry')`, { what: 'the bubble with Retry' });
        assert.equal(await page.ev(`document.getElementById('msg').value`), '', 'the text is not handed back to be sent again');
        assert.deepEqual(await page.ev(`import('/core.js').then(m => m.state.outbox.map(o => [!!o.unconfirmed, !!o.error]))`), [[true, false]], 'marked as not confirmed, not as failed');
        await page.ev(`window.landed = true, ${mine}.querySelector('wa-button.retry').click()`);
        await page.waitFor(`document.querySelectorAll('#feed wa-button.retry').length === 0 && !!${mine}`, { what: 'the delivered message without Retry' });
        assert.equal(await page.ev(`window.sends`), 1, 'no second copy');
    },

    'a huge table and a huge code block render in part, with a step that shows all': async ({ page, open, answerPosts }) => {
        const table = ['| a | b |', '|---|---|', ...Array.from({ length: 1500 }, (_, n) => `| r${n} | src/file${n}.js |`)].join('\n');
        const code = ['```', ...Array.from({ length: 5000 }, (_, n) => `line ${n}`), '```'].join('\n');
        const items = [{ role: 'assistant', id: 'big', at: new Date().toISOString(), tldr: 'big reply', text: `${table}\n\n${code}` }];
        await open();
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify({ items, working: false, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        const counts = `[document.querySelectorAll('#feed tbody tr').length, document.querySelector('#feed pre code')?.textContent.split('\\n').length ?? 0, document.querySelectorAll('#feed .show-all').length]`;
        await page.waitFor(`document.getElementById('feed').textContent.includes('big reply') && document.querySelector('#feed .bubble.assistant .show')`, { what: 'the folded reply' });
        await page.clickOn(`document.querySelector('#feed .bubble.assistant .show:not(.show-all)')`);
        const [rows, lines, steps] = await page.ev(counts);
        assert.ok(rows > 0 && rows < 1500, `${rows} of 1500 rows at first`);
        assert.ok(lines > 0 && lines < 5000, `${lines} of 5000 lines at first`);
        assert.equal(steps, 2, 'one step per cut block');
        await page.ev(`document.querySelectorAll('#feed .show-all').forEach(b => b.click())`);
        const all = await page.ev(counts);
        assert.deepEqual([all[0], all[1] >= 5000, all[2]], [1500, true, 0], 'everything after the step');
        assert.ok(await page.ev(`!!document.querySelector('#feed tbody tr:last-child code')`), 'the late rows get the same file-path styling');
        // it stays shown over the next redraw
        items.push({ role: 'user', text: 'go on', at: new Date().toISOString() }, { role: 'assistant', id: 'next', at: new Date().toISOString(), text: 'a later reply' });
        await page.waitFor(`document.getElementById('feed').textContent.includes('a later reply')`, { what: 'the redraw' });
        assert.equal((await page.ev(counts))[0], 1500, 'still all rows');
    },

    'the draft is dropped when a send starts, so a reload during a slow send does not put the sent text back': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(loaded, { what: 'the chat' });
        const draft = `sessionStorage.getItem('draft:${IDS.master}')`;
        await page.ev(`(() => { const f = window.fetch; window.fetch = (u, o) => (String(u).startsWith('/api/send') ? new Promise(ok => { window.answer = () => ok(new Response('nope', { status: 500 })); }) : f(u, o)); })()`);
        await page.click('#msg');
        await page.type('sent slowly');
        await page.waitFor(`${draft}?.includes('sent slowly')`, { what: 'the draft of the typed text' });
        await page.key('Enter');
        await page.waitFor(`typeof window.answer === 'function'`, { what: 'the send in flight' });
        assert.equal(await page.ev(draft), null, 'no draft while it is being sent');
        await page.ev(`window.answer()`);
        await page.waitFor(`document.getElementById('msg').value === 'sent slowly' && ${draft}?.includes('sent slowly')`, { what: 'a failed send hands the text back, as a draft again' });
    }
};
