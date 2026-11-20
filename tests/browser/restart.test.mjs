import assert from 'node:assert/strict';

const token = `import('/core.js').then(m => m.page.token ?? document.querySelector('meta[name=homebase-token]').content)`;

export default {
    'a server restart rotates the token without a reload, and the draft survives': async ({ page, open, restartServer }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        await page.click('#msg');
        await page.type('a draft that must survive');
        const before = { token: await page.ev(token), navigations: page.navigations };
        await restartServer();
        await page.waitFor(`${token}.then(t => t !== ${JSON.stringify(before.token)})`, { timeout: 20_000, what: 'the new token' });
        await page.waitFor(`document.getElementById('offline').hidden && document.getElementById('status').className === 'c-status idle'`, { timeout: 10_000, what: 'online again' });
        assert.equal(page.navigations, before.navigations, 'no navigation');
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'a draft that must survive');
        assert.equal(await page.ev(`document.getElementById('updated').hidden`), true, 'same build, no update banner');
    }
};
