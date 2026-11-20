import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// The remote port stands in for tailscale serve: http://localhost:<remotePort> instead of https://<mac>.<tailnet>.ts.net.
// The /api/pair/*, /api/tracked and /pair POSTs reach the server; they touch only devices.json and tracked.json in the test's data dir.
const macRoute = answerPosts => q => (q.url.includes('/api/pair/') || q.url.includes('/api/tracked') ? null : answerPosts(q));
async function openPairDialog(page) {
    await page.click('#manage');
    await page.waitFor(`document.querySelector('.d-pair-btn')`, { what: 'the Pair a device button' });
    await page.click('.d-pair-btn');
}

export default {
    'a phone pairs with a code from the Mac, sees the Mac\'s projects, and Revoke sends it back to the pair page': async ({ page, open, base, remoteBase, answerPosts, homebase }) => {
        const trackedFile = join(homebase, 'tracked.json');
        await open();
        rmSync(trackedFile, { force: true }); // none saved yet, as before this Homebase version
        page.route = macRoute(answerPosts);
        await page.goto(base); // the Mac's browser has alpha, beta and gamma on its board and hands them to the server
        for (let i = 0; i < 50 && !existsSync(trackedFile); i++) {
            await new Promise(r => setTimeout(r, 100));
        }
        assert.ok(existsSync(trackedFile), 'the Mac saved its board projects on the server');
        await openPairDialog(page);
        const code = await page.waitFor(`/^\\d{6}$/.test(document.getElementById('pair-code').textContent) && document.getElementById('pair-code').textContent`, { what: 'a pairing code' });
        await page.waitFor(`document.getElementById('pair-list').textContent === 'None yet.'`, { what: 'an empty device list' });

        // the phone: unpaired, so the pair page and no token
        page.route = q => (q.url.startsWith(remoteBase) ? null : answerPosts(q));
        await page.goto(remoteBase);
        assert.equal(await page.ev(`document.querySelector('h1').textContent`), 'Pair this device');
        assert.equal(await page.ev(`document.querySelector('meta[name="homebase-token"]')`), null);
        await page.ev(`document.getElementById('code').value = ${JSON.stringify(code)}; document.getElementById('name').value = 'Test phone'; document.querySelector('form').requestSubmit()`);
        await page.waitFor(`document.querySelector('meta[name="homebase-token"]')?.content.length === 64`, { what: 'the app with its token after pairing' });
        // the phone's own storage is empty (another origin), yet it shows the Mac's projects and their chats
        await page.waitFor(`document.querySelector('#masters tr[data-key]')`, { what: 'the Mac\'s projects on the paired phone' });
        assert.equal(await page.ev(`document.querySelector('#masters .welcome')`), null);
        assert.equal(await page.ev(`document.cookie`), '', 'the device cookie is HttpOnly');
        // opened from another app or the home screen (a cross-site top-level navigation): still paired, no new pair page
        await page.goto(base.replace('localhost', '127.0.0.1'));
        await page.ev(`location.assign(${JSON.stringify(remoteBase)})`);
        await page.waitFor(`location.href === ${JSON.stringify(remoteBase)} && document.readyState === 'complete' && document.querySelector('h1, meta[name="homebase-token"]')`, { what: 'the remote page after a cross-site open' });
        assert.equal(await page.ev(`document.querySelector('meta[name="homebase-token"]')?.content.length`), 64, 'a cross-site open keeps the pairing');

        // the Mac lists it; Revoke removes it
        await open();
        page.route = macRoute(answerPosts);
        await openPairDialog(page);
        await page.waitFor(`document.querySelector('#pair-list .p-row span')?.textContent === 'Test phone'`, { what: 'the paired device in the list' });
        await page.clickOn(`document.querySelector('#pair-list .p-row wa-button')`, 'Revoke');
        await page.waitFor(`document.getElementById('pair-list').textContent === 'None yet.'`, { what: 'the device to go' });

        page.route = q => (q.url.startsWith(remoteBase) ? null : answerPosts(q));
        await page.goto(remoteBase);
        assert.equal(await page.ev(`document.querySelector('h1')?.textContent`), 'Pair this device');
        await page.goto(base);
    }
};
