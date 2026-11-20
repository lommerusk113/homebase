import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const btn = `document.getElementById('c-model-btn')`;

export default {
    'the model chip shows the chat model, and picking one posts /model <alias> and shows it pending': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`${btn}?.textContent === 'Opus ▾' && !document.getElementById('c-model').hidden`, { what: 'the Opus chip' });
        assert.equal(await page.ev(`getComputedStyle(${btn}).borderTopWidth`), '0px', 'no border');
        assert.ok(await page.ev(`${btn}.getBoundingClientRect().height <= document.getElementById('status').getBoundingClientRect().height`), 'fits the status row');
        await page.click('#c-model-btn');
        await page.clickOn(`document.querySelector('#c-model wa-dropdown-item[value="sonnet"]')`);
        await page.waitFor(`${btn}.textContent === 'Sonnet…' && ${btn}.classList.contains('pending')`, { what: 'the pending chip' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, '/model sonnet']]);
        const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
        writeFileSync('/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad/model-chip.png', Buffer.from(shot.data, 'base64'));
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`${btn}.getBoundingClientRect().width > 0`, { what: 'the chip at phone width' });
        for (let i = 0; i < 10 && !(await page.ev(`document.getElementById('c-model').open`)); i++) { // a click while the pick's close animation runs is dropped
            await page.click('#c-model-btn');
            await new Promise(r => setTimeout(r, 200));
        }
        await page.waitFor(`document.getElementById('c-model').open`, { what: 'the picker open' });
        const fits = `(() => { const r = document.querySelector('#c-model wa-dropdown-item[value="default"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= document.getElementById('status').getBoundingClientRect().top + 4; })()`;
        await page.waitFor(fits, { what: 'the picker on screen, above the chip' });
        await new Promise(r => setTimeout(r, 500)); // the popup's fade-in
        const phone = await page.cmd('Page.captureScreenshot', { format: 'png' });
        writeFileSync('/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad/model-chip-390.png', Buffer.from(phone.data, 'base64'));
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); // the harness's size (cdp.mjs)
    }
};
