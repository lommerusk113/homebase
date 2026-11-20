import assert from 'node:assert/strict';

// The remote port stands in for tailscale serve: http://localhost:<remotePort> instead of https://<mac>.<tailnet>.ts.net.
// The /api/pair/* and /pair POSTs reach the server; they touch only devices.json in the test's data dir.
const macRoute = answerPosts => q => (q.url.includes('/api/pair/') ? null : answerPosts(q));
async function openPairDialog(page) {
    await page.click('#manage');
    await page.waitFor(`document.querySelector('.d-pair-btn')`, { what: 'the Pair a device button' });
    await page.click('.d-pair-btn');
}

export default {
    'a phone pairs with a code from the Mac, and Revoke sends it back to the pair page': async ({ page, open, base, remoteBase, answerPosts }) => {
        await open();
        page.route = macRoute(answerPosts);
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
        await page.waitFor(`document.querySelector('#masters tr[data-key], #masters .s-row, #masters .welcome')`, { what: 'the board on the paired phone' });
        assert.equal(await page.ev(`document.cookie`), '', 'the device cookie is HttpOnly');

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
