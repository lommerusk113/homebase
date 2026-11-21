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
    }
};
