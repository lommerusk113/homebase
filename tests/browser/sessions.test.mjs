import assert from 'node:assert/strict';
import { IDS } from './fixture.mjs';

const srow = id => `document.querySelector('#masters .s-row[data-key="session:${id}"]')`;

export default {
    'a working session shows its state, Now and the queued chip': async ({ page, open }) => {
        await open();
        await page.waitFor(`${srow(IDS.worker)}`, { what: 'the worker row' });
        assert.equal(await page.ev(`document.querySelector('#masters > *').className`), 'group g-sessions', 'the strip leads the Work tab');
        // three alpha masters, newest two shown (the binding test may have made the third newest)
        assert.equal(await page.ev(`document.querySelectorAll('#masters .s-row').length`), 2);
        assert.equal(await page.ev(`document.querySelector('#masters .s-older').textContent`), '+1 older');
        await page.click('#masters .s-older');
        await page.waitFor(`document.querySelectorAll('#masters .s-row').length === 3 && !document.querySelector('#masters .s-older')`, { what: 'all three rows' });
        assert.ok(await page.ev(`!document.querySelector('#masters .s-row[data-key*="agent-"]')`), 'no subagent rows');
        assert.equal(await page.ev(`${srow(IDS.worker)}.className`), 's-row s-working');
        assert.match(await page.ev(`${srow(IDS.worker)}.querySelector('.s-state').textContent`), /^working/);
        assert.equal(await page.ev(`${srow(IDS.worker)}.querySelector('.s-topic').textContent`), 'Now: Refactor the session store');
        assert.equal(await page.ev(`${srow(IDS.worker)}.querySelector('.s-queued').textContent`), 'Queued: 1');
        assert.equal(await page.ev(`${srow(IDS.master)}.querySelector('.s-topic').textContent`), 'Release');
        assert.equal(await page.ev(`${srow(IDS.master)}.querySelector('.s-counts').textContent`), '1 running · 2 finished');
        assert.equal(await page.ev(`${srow(IDS.master)}.querySelector('.s-chat')?.textContent`), 'chat', 'the bound session is marked');
    },

    'an issue the chat took on shows a starting placeholder in Doing': async ({ page, open }) => {
        await open();
        const tr = `document.querySelector('#masters .g-doing tr[data-key="starting:${IDS.worker}:7"]')`;
        await page.waitFor(tr, { what: 'the #7 placeholder' });
        assert.equal(await page.ev(`${tr}.querySelector('b').textContent`), ' #7 · starting…');
        assert.equal(await page.ev(`${tr}.querySelector('.next').textContent`), 'Queued in the chat session');
        await page.click(`#masters tr[data-key="starting:${IDS.worker}:7"]`);
        await page.waitFor(`localStorage.getItem('chat') === ${JSON.stringify(IDS.worker)}`, { what: 'the chat to bind the worker' });
    },

    'only folded groups: the empty line sits under the strip': async ({ page, open }) => {
        await open({ tracked: '["delta"]', project: 'delta', chat: null });
        await page.waitFor(`document.querySelector('#masters .d-empty')`, { what: 'the empty line' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#masters > *')].map(e => e.className)`), ['group g-sessions', 'd-empty', 'group g-finished']);
        assert.equal(await page.ev(`document.querySelector('#masters .d-empty').textContent`), 'No MRs or subagents right now');
        assert.equal(await page.ev(`document.querySelector('#masters .welcome')`), null);
    },

    'clicking a session row binds the chat to it': async ({ page, open }) => {
        await open();
        await page.waitFor(`${srow(IDS.worker)}`, { what: 'the worker row' });
        await page.click(`#masters .s-row[data-key="session:${IDS.worker}"]`);
        await page.waitFor(`${srow(IDS.worker)}?.classList.contains('bound') && ${srow(IDS.worker)}.querySelector('.s-chat')`, { what: 'the worker row to be bound' });
        assert.equal(await page.ev(`localStorage.getItem('chat')`), IDS.worker);
        assert.equal(await page.ev(`localStorage.getItem('chat:alpha')`), IDS.worker);
        assert.equal(await page.ev(`document.querySelectorAll('#masters .s-row.bound').length`), 1, 'only the worker is bound');
        await page.waitFor(`document.getElementById('status-text').textContent.startsWith('Claude is working…')`, { what: 'the chat to show the worker' });
    }
};
