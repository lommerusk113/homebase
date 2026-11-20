import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const item = `document.getElementById('compact-item')`;
const nudge = `document.getElementById('compact-nudge')`;
const compactPosts = page => page.posts.filter(p => new URL(p.url).pathname === '/api/compact').map(p => new URL(p.url).search);
const waitForPost = async page => {
    for (let i = 0; i < 100 && !compactPosts(page).length; i++) {
        await sleep(100);
    }
};
const loaded = (page, expr = nudge) => page.waitFor(`${expr} && !${expr}.hidden`, { what: 'the chat to load' });

export default {
    'the chat header shows context %, amber from 60% and red from 85%': async ({ page, open, IDS }) => {
        const gauge = `document.getElementById('status-ctx')`;
        await open({ chat: IDS.master });
        await page.waitFor(`${gauge}.textContent === 'context 72%'`, { what: 'the master gauge' });
        assert.equal(await page.ev(`${gauge}.className`), 'c-ctx warn');
        await open({ chat: IDS.worker });
        await page.waitFor(`${gauge}.textContent !== '' && ${gauge}.textContent !== 'context 72%'`, { what: 'the worker gauge' });
        assert.equal(await page.ev(`${gauge}.className.trim()`), 'c-ctx', 'muted under 60%');
        await open({ project: 'beta', chat: IDS.asker });
        await page.waitFor(`${gauge}.className === 'c-ctx hot'`, { what: 'the asker gauge' });
    },

    'the nudge asks first, then POSTs /api/compact once for the bound session': async ({ page, open, IDS }) => {
        await open({ 'auto-compact': '0' });
        await loaded(page);
        assert.equal(await page.ev(`${nudge}.textContent`), 'Compact?');
        await page.click('#compact-nudge');
        await page.waitFor(`document.getElementById('compact-dlg').open`, { what: 'the confirm' });
        await page.ev(`document.getElementById('compact-dlg').open = false`);
        await sleep(300);
        assert.deepEqual(compactPosts(page), [], 'cancelling sends nothing');
        await page.click('#compact-nudge');
        await page.waitFor(`document.getElementById('compact-dlg').open`, { what: 'the confirm' });
        await page.click('#compact-go');
        await waitForPost(page);
        assert.deepEqual(compactPosts(page), [`?id=${IDS.master}`]);
    },

    'the menu item is enabled when idle and compacts through the same confirm': async ({ page, open, IDS }) => {
        await open({ 'auto-compact': '0' });
        await page.waitFor(`${item} && !${item}.disabled`, { what: 'the enabled menu item' });
        await page.click('#c-menu button[slot="trigger"]');
        await page.clickOn(item);
        await page.waitFor(`document.getElementById('compact-dlg').open`, { what: 'the confirm' });
        await page.click('#compact-go');
        await waitForPost(page);
        assert.deepEqual(compactPosts(page), [`?id=${IDS.master}`]);
    },

    'working or asking: no nudge, and the menu item is disabled': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        await page.waitFor(`document.getElementById('status-text').textContent.startsWith('Claude is working…')`, { what: 'working' });
        assert.equal(await page.ev(`${item}.disabled`), true);
        assert.equal(await page.ev(`${nudge}.hidden`), true);

        await open({ project: 'beta', chat: IDS.asker });
        await page.waitFor(`document.getElementById('status').classList.contains('asking')`, { what: 'asking' });
        assert.equal(await page.ev(`${item}.disabled`), true, 'asking, even at 90%');
        assert.equal(await page.ev(`${nudge}.hidden`), true);
    },

    'the chat shows a divider at the compact boundary, not the summary': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the chat' });
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .tools.compact')].map(t => t.textContent).join()`), 'Conversation compacted');
        assert.equal(await page.ev(`document.getElementById('feed').textContent.includes('SUMMARY-TEXT')`), false);
    },

    'auto-compact: on by default, an explicit off is respected; it sends once for the idle chat over 200k tokens': async ({ page, open, IDS }) => {
        await open({ 'auto-compact': '0' });
        await loaded(page);
        await sleep(3500); // a poll or two
        assert.deepEqual(compactPosts(page), [], 'explicit off');
        assert.equal(await page.ev(`document.getElementById('auto-compact').checked`), false);

        await open({ 'auto-compact': null });
        await waitForPost(page);
        await sleep(3500); // more polls: the hourly limit holds
        assert.deepEqual(compactPosts(page), [`?id=${IDS.master}`]);
        assert.equal(await page.ev(`document.getElementById('auto-compact').checked`), true);
    },

    'auto-compact leaves a chat alone that was compacted within the hour': async ({ page, open, IDS }) => {
        await open({ 'auto-compact': '1', [`auto-compacted:${IDS.master}`]: String(Date.now() - 600_000) });
        await loaded(page);
        await sleep(3500);
        assert.deepEqual(compactPosts(page), []);
    },

    'the Restart chat menu item asks to confirm first, and Cancel posts nothing': async ({ page, open }) => {
        await open();
        await loaded(page);
        await page.click('#c-menu button[slot="trigger"]');
        await page.clickOn(`document.getElementById('restart-item')`);
        await page.waitFor(`document.getElementById('restart-dlg').open`, { what: 'the confirm' });
        await sleep(500);
        assert.deepEqual(page.posts.filter(p => new URL(p.url).pathname === '/api/restart'), []);
        await page.ev(`document.getElementById('restart-dlg').open = false`);
        await sleep(300);
        assert.deepEqual(page.posts.filter(p => new URL(p.url).pathname === '/api/restart'), []);
    },

    'confirming Restart chat POSTs /api/restart for the bound session': async ({ page, open, IDS }) => {
        await open();
        await loaded(page);
        await page.click('#c-menu button[slot="trigger"]');
        await page.clickOn(`document.getElementById('restart-item')`);
        await page.waitFor(`document.getElementById('restart-dlg').open`, { what: 'the confirm' });
        await page.click('#restart-go');
        for (let i = 0; i < 100 && !page.posts.some(p => new URL(p.url).pathname === '/api/restart'); i++) {
            await sleep(100);
        }
        const posts = page.posts.filter(p => new URL(p.url).pathname === '/api/restart').map(p => new URL(p.url).search);
        assert.deepEqual(posts, [`?id=${IDS.master}`]);
        await page.waitFor(`document.getElementById('c-info').textContent === ''`, { what: 'the neutral Restarting line to clear' });
        assert.equal(await page.ev(`document.getElementById('c-err').getAttribute('role')`), 'alert');
    }
};
