import assert from 'node:assert/strict';
import { statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from './cdp.mjs';

// Moves a stand-in code file's mtime (the server watches ctx.code) a minute ahead while fn runs, then puts it back.
async function touched(path, fn) {

    const { atime, mtime } = statSync(path);
    utimesSync(path, atime, new Date(Date.now() + 60_000));
    try {
        await fn();
    } finally {
        utimesSync(path, atime, mtime);
    }
}
const banner = `document.getElementById('updated').hidden ? '' : document.getElementById('updated').textContent`;

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
    },
    'a changed browser file offers Refresh, changed server code offers Reload server': async ({ page, open, code }) => {
        await open();
        await sleep(1500); // the first poll's /api/version is the baseline
        assert.equal(await page.ev(banner), '');
        await touched(join(code, 'public/styles.css'), () => page.waitFor(`(${banner}) === 'Page updated — Refresh'`, { timeout: 10_000, what: 'the refresh note' }));
        await touched(join(code, 'server/rules.mjs'), () => page.waitFor(`(${banner}) === 'Homebase was updated — Reload server'`, { timeout: 10_000, what: 'the reload note' }));
    }
};
