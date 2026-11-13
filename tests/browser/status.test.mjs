import assert from 'node:assert/strict';

const status = `document.getElementById('status').className + ' | ' + document.getElementById('status-text').textContent`;

export default {
    'status bar: idle': async ({ page, open }) => {
        await open();
        await page.waitFor(`${status} === 'c-status idle | Idle — waiting for you'`, { what: 'idle' });
        assert.equal(await page.ev(`document.getElementById('ask').hidden`), true);
    },

    'status bar: working, with the queued message': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        await page.waitFor(`${status}.startsWith('c-status working | Claude is working…')`, { what: 'working' });
        await page.waitFor(`[...document.querySelectorAll('#feed .bubble.user')].some(b => b.textContent.includes('also update the docs') && b.querySelector('.b-note')?.textContent.startsWith('queued'))`, { what: 'the queued bubble' });
        assert.equal(await page.ev(`document.querySelector('#feed .replies')`), null, 'no quick replies while working');
    },

    'status bar: asking, with the question and its options': async ({ page, open, IDS }) => {
        await open({ project: 'beta', chat: IDS.asker });
        await page.waitFor(`${status} === 'c-status asking | Claude is asking — answer below'`, { what: 'asking' });
        assert.equal(await page.ev(`document.getElementById('ask').hidden`), false);
        assert.equal(await page.ev(`document.querySelector('#ask-q p').textContent`), 'Which database should be the default?');
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#ask-q li')].map(l => l.textContent)`), ['Postgres', 'SQLite']);
        assert.equal(await page.ev(`document.getElementById('ask-cmd').textContent`), `tmux attach -t cc-${IDS.asker.slice(0, 8)}`);
        await page.waitFor(`document.title === '(1) Homebase'`, { what: 'the title count' });
    },

    'status bar: error while the transcript fails, then back': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`${status} === 'c-status idle | Idle — waiting for you'`, { what: 'idle first' });
        page.route = q => (q.url.includes('/api/transcript') ? { status: 503, body: 'down' } : answerPosts(q));
        await page.waitFor(`${status} === 'c-status error | Can’t reach Homebase — reconnecting…'`, { what: 'error' });
        page.route = answerPosts;
        await page.waitFor(`${status} === 'c-status idle | Idle — waiting for you'`, { what: 'idle again' });
    }
};
