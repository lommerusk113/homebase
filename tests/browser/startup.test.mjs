import assert from 'node:assert/strict';

const byId = id => `document.getElementById('${id}')`;
const DIALOG = { question: 'Quick safety check: Is this a project you created or one you trust?', options: ['No, exit', 'Yes, I trust this folder'], selected: 0 };

// A new project whose chat has no transcript yet, with the pane capture stubbed: /api/startup answers the dialog until an option is posted.
export default {
    'a startup dialog shows its options, blocks sending, and a click answers exactly that option': async ({ page, open, answerPosts }) => {
        await open();
        let dialog = DIALOG;
        page.route = q => {
            if (q.url.includes('/api/startup')) {
                if (q.method === 'POST') {
                    dialog = null;

                    return { body: 'ok' };
                }

                return { body: JSON.stringify({ dialog }), headers: { 'content-type': 'application/json' } };
            }

            return answerPosts(q);
        };
        // what New project does when the session id isn't known yet
        await page.ev(`(async () => {
            const { state } = await import('/core.js');
            const { refreshChat } = await import('/chat.js');
            localStorage.removeItem('chat:alpha');
            state.chat = null;
            state.sessions = [];
            state.starting = '/x/newrepo';
            state.startingTmux = 'cc-new-newrepo';
            refreshChat();
        })()`);
        await page.waitFor(`!${byId('boot')}.hidden`, { what: 'the startup panel' });
        assert.equal(await page.ev(`${byId('boot-q')}.textContent`), DIALOG.question);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#boot-opts wa-button')].map(b => b.textContent)`), DIALOG.options);
        assert.equal(await page.ev(`${byId('boot-cmd')}.textContent`), 'tmux attach -t cc-new-newrepo');

        // the message box refuses while it is up
        await page.click('#msg');
        await page.type('hello');
        await page.key('Enter');
        await page.waitFor(`${byId('c-err')}.textContent === 'Claude is waiting on a startup question above'`, { what: 'the block message' });
        assert.equal(await page.ev(`${byId('msg')}.value`), 'hello', 'the text stays');
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')), []);

        await page.ev(`document.querySelectorAll('#boot-opts wa-button')[1].click()`);
        await page.waitFor(`${byId('boot')}.hidden`, { what: 'the panel to close' });
        const post = page.posts.find(p => p.url.includes('/api/startup'));
        const u = new URL(post.url);
        assert.deepEqual([u.searchParams.get('tmux'), u.searchParams.get('option'), u.searchParams.get('label')], ['cc-new-newrepo', '1', 'Yes, I trust this folder']);
    }
};
