import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const srow = id => `document.querySelector('#masters .s-row[data-key="session:${id}"]')`;
const ctx = id => `${srow(id)}.querySelector('.s-ctx')`;
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
    'the one-liner shows ctx %, amber from 60% and red from 85%': async ({ page, open, IDS }) => {
        await open({ 'sessions-open:alpha': '1' });
        await page.waitFor(ctx(IDS.worker), { what: 'the ctx gauges' });
        assert.equal(await page.ev(`${ctx(IDS.master)}.textContent`), 'ctx 72%');
        assert.equal(await page.ev(`${ctx(IDS.master)}.className`), 's-ctx warn');
        assert.equal(await page.ev(`${ctx(IDS.worker)}.className`), 's-ctx', 'muted under 60%');
        assert.equal(await page.ev(`${ctx(IDS.other)}`), null, 'no dump, no gauge');
        const colour = id => page.ev(`getComputedStyle(${ctx(id)}).color`);
        assert.notEqual(await colour(IDS.master), await colour(IDS.worker), 'amber differs from muted');

        await open({ project: 'beta', chat: IDS.asker });
        await page.waitFor(ctx(IDS.asker), { what: 'the asker gauge' });
        assert.equal(await page.ev(`${ctx(IDS.asker)}.className`), 's-ctx hot');
        assert.notEqual(await colour(IDS.asker), await page.ev(`getComputedStyle(${srow(IDS.asker)}.querySelector('.s-state')).color`));
    },

    'the nudge asks first, then POSTs /api/compact once for the bound session': async ({ page, open, IDS }) => {
        await open();
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
        await open();
        await page.waitFor(`${item} && !${item}.disabled`, { what: 'the enabled menu item' });
        await page.click('#c-menu button[slot="trigger"]');
        await page.clickOn(item);
        await page.waitFor(`document.getElementById('compact-dlg').open`, { what: 'the confirm' });
        await page.click('#compact-go');
        await waitForPost(page);
        assert.deepEqual(compactPosts(page), [`?id=${IDS.master}`]);
        assert.ok(!await page.ev(`localStorage.getItem('auto-compact')`), 'auto mode stays off');
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

    'auto-compact: off by default; on, it sends once for the idle chat over 70%': async ({ page, open, IDS }) => {
        await open();
        await loaded(page);
        await sleep(3500); // a poll or two
        assert.deepEqual(compactPosts(page), [], 'off by default');

        await open({ 'auto-compact': '1' });
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
    }
};
