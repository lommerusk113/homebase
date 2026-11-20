import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const btn = `document.getElementById('c-model-btn')`;

export default {
    'the model chip shows the chat model, and picking one posts /model <alias> and shows it pending': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`${btn}?.textContent === 'Opus ▾' && !document.getElementById('c-model').hidden`, { what: 'the Opus chip' });
        assert.equal(await page.ev(`getComputedStyle(${btn}).borderTopWidth`), '0px', 'no border');
        assert.ok(await page.ev(`${btn}.getBoundingClientRect().height <= document.querySelector('.c-head').getBoundingClientRect().height`), 'fits the header');
        await page.click('#c-model-btn');
        await page.clickOn(`document.querySelector('#c-model wa-dropdown-item[value="sonnet"]')`);
        await page.waitFor(`${btn}.textContent === 'Sonnet…' && ${btn}.classList.contains('pending')`, { what: 'the pending chip' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, '/model sonnet']]);
        const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
        writeFileSync('/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad/model-chip.png', Buffer.from(shot.data, 'base64'));
    }
};
