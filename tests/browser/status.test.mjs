import assert from 'node:assert/strict';

const status = `document.getElementById('status').className + ' | ' + document.getElementById('status-text').textContent`;

export default {
    'status bar: idle': async ({ page, open }) => {
        await open();
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer · 2 agents still working'`, { what: 'idle' });
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
        await page.waitFor(`${status} === 'c-status asking | Claude is asking — see the question above'`, { what: 'asking' });
        assert.equal(await page.ev(`document.getElementById('ask').hidden`), false);
        // not in tmux (no pane to answer on): the transcript's question, its options read-only
        await page.waitFor(`document.getElementById('ask-q').textContent === 'Which database should be the default?'`, { what: 'the question' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#ask-opts .c-opt')].map(l => l.tagName + ' ' + l.textContent)`), ['DIV Postgres', 'DIV SQLite']);
        assert.equal(await page.ev(`document.getElementById('ask-cmd').textContent`), `tmux attach -t cc-${IDS.asker.slice(0, 8)}`);
        await page.waitFor(`document.title === '(1) Homebase'`, { what: 'the title count' });
    },

    'an asking card answers the question on the pane by its button': async ({ page, open, IDS, answerPosts }) => {
        await open({ project: 'beta', chat: IDS.asker });
        let question = { question: 'Which database should be the default?', options: ['SQLite (Recommended)', 'Postgres', 'Type something.', 'Chat about this'], descriptions: ['file based', 'from the pane', '', ''], selected: 0 };
        page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
            ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
            : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
        const opts = `[...document.querySelectorAll('#ask-opts wa-button')]`;
        await page.waitFor(`${opts}.length === 2`, { what: 'the option buttons' });
        assert.deepEqual(await page.ev(`${opts}.map(b => [b.firstChild.textContent, b.querySelector('small')?.textContent, b.getAttribute('variant')])`),
            [['SQLite (Recommended)', 'file based', 'brand'], ['Postgres', 'from the pane', 'neutral']], 'free-form entries left out; the recommended one is primary');
        await page.ev(`${opts}[1].click()`);
        await page.waitFor(`document.querySelectorAll('#ask-opts wa-button').length === 0`, { what: 'the read-only fallback once the pane has no question' });
        const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
        assert.deepEqual([u.searchParams.get('tmux'), u.searchParams.get('option'), u.searchParams.get('label')], [`cc-${IDS.asker.slice(0, 8)}`, '1', 'Postgres']);
    },

    'status bar: error while the transcript fails, then back': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer · 2 agents still working'`, { what: 'idle first' });
        page.route = q => (q.url.includes('/api/transcript') ? { status: 503, body: 'down' } : answerPosts(q));
        await page.waitFor(`${status} === 'c-status error | Can’t reach Homebase — reconnecting…'`, { what: 'error' });
        page.route = answerPosts;
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer · 2 agents still working'`, { what: 'idle again' });
    }
};
