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
            { role: 'assistant', id: 'a2', at: at(2), text: 'reply after the svg' }
        ]);
        await page.waitFor(`${texts}.includes('reply after the svg')`, { what: 'the feed with an SVG link' });
        assert.ok((await page.ev(texts)).includes('svg-reply'), 'the SVG reply is there too');
        // an item no renderer expects
        page.route = feedOf([
            { role: 'assistant', id: 'b1', at: at(3), text: { odd: 'shape' }, tldr: 7 },
            { role: 'assistant', id: 'b2', at: at(4), text: 'reply after the odd one' }
        ]);
        await page.waitFor(`${texts}.includes('reply after the odd one')`, { what: 'the feed with an odd item' });
        assert.equal(await page.ev(`document.querySelectorAll('#feed .bubble').length`), 2, 'the odd item keeps its place');
        assert.ok((await page.ev(texts)).includes('shape'), 'with its text');
    },

    'a chat whose turn died keeps a row on the board until it is opened': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        await page.waitFor(`document.querySelector('#masters tr')`, { what: 'the board' });
        const row = `document.querySelector('#masters tr[data-key="died:${IDS.other}"]')`;
        assert.equal(await page.ev(`!!${row}`), false, 'no row while nothing died');
        await page.ev(`(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o); if (!String(u).startsWith('/api/sessions')) return r; const list = await r.json(); for (const s of list) { if (s.id === ${JSON.stringify(IDS.other)}) { s.died = true; s.status = 'idle'; } } return new Response(JSON.stringify(list), { status: 200 }); }; })()`);
        await page.waitFor(`!!${row}`, { what: 'the row of the died turn' });
        await page.clickOn(row);
        await page.waitFor(`!${row}`, { what: 'the row gone once looked at' });
        assert.equal(await page.ev(`document.getElementById('feed').textContent.includes('The cache is fine')`), true, 'and its chat open');
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
    }
};
