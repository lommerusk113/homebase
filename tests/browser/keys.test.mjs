import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const focused = `document.activeElement?.dataset?.key ?? null`;
const visibleKeys = `[...document.querySelectorAll('#masters tr[data-key]')].filter(r => r.checkVisibility()).map(r => r.dataset.key)`;

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
