import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const row = id => `#masters tr[data-key="asking:${id}"]`;
const back = `document.getElementById('c-back')`;
const title = `document.getElementById('msg').getAttribute('placeholder').replace(/^Message Claude in (.*)…$/, '$1')`;
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

    'a chat with a pending question shows Needs you on its row, and the row opens the question in that chat': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${row(IDS.asker)}')`, { what: 'the asking row' });
        assert.equal(await page.ev(`getComputedStyle(document.querySelector('${row(IDS.asker)} .needs-you-mark'), '::after').content`), '"Needs you"');
        await page.click(row(IDS.asker));
        await page.waitFor(`!document.getElementById('ask').hidden && /Which database/.test(document.getElementById('ask-q').textContent)`, { what: 'the question card in that chat' });
        assert.equal(await page.ev(`${back}.hidden`), false);
    },

    'a chat row has the Open chat icon, and the icon opens that chat': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        const icon = `document.querySelector('${row(IDS.asker)} wa-button.step-in')`;
        await page.waitFor(icon, { what: 'the icon on the asking row' });
        assert.deepEqual(await page.ev(`[${icon}.getAttribute('aria-label'), ${icon}.title]`), ['Open chat', 'Open chat']);
        await page.clickOn(icon);
        await page.waitFor(`!document.getElementById('ask').hidden && /Which database/.test(document.getElementById('ask-q').textContent)`, { what: "that chat's question" });
    },

    'Esc returns to the main chat': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${row(IDS.asker)}')`, { what: 'the row' });
        await page.click(row(IDS.asker));
        await page.waitFor(`!${back}.hidden`, { what: 'the back button' });
        await page.ev(`document.activeElement?.blur()`);
        await page.key('Escape');
        await page.waitFor(`${back}.hidden`, { what: 'the main chat' });
    },

    'after an answer the pane stays in that chat until the user leaves': async ({ page, open, IDS }) => {
        await open({ project: 'alpha', chat: IDS.worker }); // only the master waits in alpha
        await page.waitFor(`document.querySelector('${row(IDS.master)}')`, { what: 'the row' });
        await page.click(row(IDS.master));
        await page.waitFor(`!${back}.hidden`, { what: 'the back button' });
        await page.ev(`import('/chat.js').then(m => m.sendText(${JSON.stringify(IDS.master)}, 'Yes, tag it'))`);
        await new Promise(r => setTimeout(r, 2500)); // past the old 1.5s automatic return
        assert.equal(await page.ev(`${back}.hidden`), false, 'still in the chat after the send');
        assert.equal(await page.ev(`document.getElementById('c-next').hidden`), true);
        await page.click('#c-back');
        await page.waitFor(`${back}.hidden`, { what: 'the main chat, by the user' });
    },

    'after an answer with another needs-you waiting, a Next link replaces the return': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelector('${row(IDS.master)}') && document.querySelector('${row(IDS.asker)}')`, { what: 'both rows' });
        await page.click(row(IDS.master));
        await page.waitFor(`!${back}.hidden`, { what: 'the back button' });
        await page.ev(`import('/chat.js').then(m => m.sendText(${JSON.stringify(IDS.master)}, 'Yes, tag it'))`);
        await page.waitFor(`!document.getElementById('c-next').hidden && /^Next: .* →$/.test(document.getElementById('c-next').textContent)`, { what: 'the Next link', timeout: 5000 });
        assert.equal(await page.ev(`${back}.hidden`), false, 'no jump back');
        await page.click('#c-next');
        await page.waitFor(`!document.getElementById('ask').hidden && /Which database/.test(document.getElementById('ask-q').textContent) && document.getElementById('c-next').hidden`, { what: "the asker's question" });
    },

    "a focused chat that was /clear'ed shows its successor, like the main chat does": async ({ page, open, IDS, homebase }) => {
        // the registry shows `other` live in an alpha chat's cc-<id8> tmux, so the server links it as that chat's /clear successor
        const reg = join(dirname(homebase), 'home', '.claude', 'sessions');
        mkdirSync(reg, { recursive: true });
        writeFileSync(join(reg, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: IDS.other, cwd: '/', tmux: 'cc-aaaaaaaa:@0.%0' }));
        try {
            await open({ project: 'all', chat: IDS.asker });
            const from = `import('/core.js').then(m => m.state.sessions.find(s => s.id === ${JSON.stringify(IDS.other)})?.clearedFrom)`;
            await page.waitFor(from, { what: 'the clear link' });
            await page.ev(`${from}.then(id => import('/chat.js').then(m => m.focusChat(id)))`);
            await page.waitFor(`import('/chat.js').then(m => m.chatSession()?.id === ${JSON.stringify(IDS.other)})`, { what: 'the successor in the pane' });
            assert.equal(await page.ev(`${back}.hidden`), false, 'still a focused chat, with the way back');
        } finally {
            rmSync(reg, { recursive: true, force: true });
        }
    }
};
