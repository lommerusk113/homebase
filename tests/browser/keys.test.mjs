import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const focused = `document.activeElement?.dataset?.key ?? null`;
const visibleKeys = `[...document.querySelectorAll('#masters .s-row[data-key], #masters tr[data-key]')].filter(r => r.checkVisibility()).map(r => r.dataset.key)`;

export default {
    '? opens the shortcuts overlay, Esc closes it': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('?', 'Slash');
        await page.waitFor(`document.querySelector('wa-dialog[label="Keyboard shortcuts"]')?.open`, { what: 'the overlay' });
        assert.match(await page.ev(`document.querySelector('wa-dialog[label="Keyboard shortcuts"] .keys-help').textContent`), /j \/ ↓Next item/);
        await page.key('Escape', 'Escape');
        await page.waitFor(`!document.querySelector('wa-dialog[label="Keyboard shortcuts"]')`, { what: 'the overlay to close' });
    },

    'j and k move the row focus': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelectorAll('#masters tr[data-key]').length >= 4`, { what: 'rows' });
        const keys = await page.ev(visibleKeys);
        await page.ev(`document.activeElement?.blur()`);
        await page.key('j');
        assert.equal(await page.ev(focused), keys[0]);
        await page.key('j');
        await page.key('j');
        assert.equal(await page.ev(focused), keys[2]);
        await page.key('k');
        assert.equal(await page.ev(focused), keys[1]);
        assert.equal(await page.ev(`document.activeElement.getAttribute('aria-selected')`), 'true');
    },

    'a chat waiting on you gets a Needs you row, and Enter on it chats with that session': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        const row = `document.querySelector('#masters .g-needs-you tr[data-key="asking:${IDS.master}"]')`;
        await page.waitFor(`${row}?.textContent.includes('needs you')`, { what: 'the needs-you row' });
        assert.match(await page.ev(`document.title`), /^\(\d+\) Homebase$/);
        await page.ev(`${row}.focus()`);
        await page.key('Enter', 'Enter');
        await page.waitFor(`localStorage.getItem('chat') === ${JSON.stringify(IDS.master)}`, { what: 'the chat to bind the master' });
    },

    'n jumps to the first chat waiting on you, from any tab': async ({ page, open, IDS }) => {
        await open({ tab: 'issues' });
        await page.ev(`document.activeElement?.blur()`);
        await page.waitFor(`document.querySelector('#masters tr[data-key="asking:${IDS.master}"]')`, { what: 'the needs-you row' });
        await page.key('n');
        assert.equal(await page.ev(`localStorage.getItem('tab')`), 'work');
        assert.equal(await page.ev(focused), `asking:${IDS.master}`);
    },

    '[ and ] cycle the tracked projects': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key(']', 'BracketRight');
        await page.waitFor(`localStorage.getItem('project') === 'beta'`, { what: 'beta' });
        await page.key('[', 'BracketLeft');
        await page.key('[', 'BracketLeft');
        await page.waitFor(`localStorage.getItem('project') === 'gamma' && document.getElementById('project').value === 'gamma'`, { what: 'gamma, wrapped around' });
    },

    'j moves through the Log tab entries': async ({ page, open }) => {
        await open({ tab: 'log' });
        await page.waitFor(`document.querySelectorAll('#log .lg-e[data-key]').length >= 2`, { what: 'log entries' });
        const keys = await page.ev(`[...document.querySelectorAll('#log .lg-e[data-key]')].map(r => r.dataset.key)`);
        await page.ev(`document.activeElement?.blur()`);
        await page.key('j');
        await page.key('j');
        assert.equal(await page.ev(focused), keys[1]);
    },

    'r refreshes once, even when pressed twice': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('r');
        await page.key('r');
        await sleep(1500);
        assert.equal(page.posts.filter(p => p.url.includes('/api/refresh')).length, 1);
        assert.equal(await page.ev(`document.getElementById('reload').classList.contains('spin')`), false, 'spinner stopped');
        assert.match(await page.ev(`document.getElementById('reload-tip').textContent`), /Last refreshed \d+s ago/);
    }
};
