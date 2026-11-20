import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

const row = id => `#masters tr[data-key="asking:${id}"]`;
const back = `document.getElementById('c-back')`;
const title = `document.getElementById('c-title').textContent`;
const focus = `document.getElementById('c-focus')`;

export default {
    "another chat's needs-you stays out of the pane until clicked; another click switches; Main chat returns": async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${row(IDS.master)}') && document.querySelector('${row(IDS.asker)}')`, { what: 'both needs-you rows' });
        assert.equal(await page.ev(`${back}.hidden && ${focus}.hidden`), true, 'no back button or context on the main chat');
        assert.equal(await page.ev(`document.getElementById('ask').hidden && document.getElementById('wait').hidden`), true, 'no foreign question in the pane');
        assert.equal(await page.ev(title), 'alpha');

        await page.click(row(IDS.asker));
        await page.waitFor(`!document.getElementById('ask').hidden && /Which database/.test(document.getElementById('ask-q').textContent)`, { what: "the asker's question" });
        assert.equal(await page.ev(`${back}.textContent`), '← Main chat');
        assert.equal(await page.ev(`${back}.hidden`), false);
        await page.waitFor(`document.querySelectorAll('#ask-opts .c-opt').length >= 2`, { what: 'its answer buttons' });
        assert.equal(await page.ev(`localStorage.getItem('chat')`), IDS.worker, 'the main chat stays bound');
        await page.waitFor(`!${focus}.hidden && ${focus}.textContent.includes('Add SQLite support')`, { what: 'the context block with the chat title' });
        if (process.env.NEEDS_SHOT) {
            writeFileSync(process.env.NEEDS_SHOT, Buffer.from((await page.cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
        }

        await page.click(row(IDS.master));
        await page.waitFor(`document.getElementById('ask').hidden && document.getElementById('feed').textContent.includes('tag the release')`, { what: "the master's own question replacing the asker's" });
        await page.waitFor(`${focus}.textContent.includes('tag the release now or wait for QA')`, { what: "the master's last reply TLDR in the context" });
        assert.equal(await page.ev(`${back}.hidden`), false);

        await page.click('#c-back');
        await page.waitFor(`${back}.hidden && ${focus}.hidden && ${title} === 'alpha' && document.getElementById('wait').hidden`, { what: 'the main chat back' });
    },

    'Esc returns to the main chat': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${row(IDS.asker)}')`, { what: 'the row' });
        await page.click(row(IDS.asker));
        await page.waitFor(`!${back}.hidden`, { what: 'the back button' });
        await page.ev(`document.activeElement?.blur()`);
        await page.key('Escape');
        await page.waitFor(`${back}.hidden`, { what: 'the main chat' });
    }
};
