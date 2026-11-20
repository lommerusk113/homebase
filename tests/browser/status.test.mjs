import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestion } from '../../server/startup.mjs';
import { seenHash } from '../../public/core.js';

const status = `document.getElementById('status').className + ' | ' + document.getElementById('status-text').textContent`;

export default {
    'status bar: idle': async ({ page, open }) => {
        await open();
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer · 2 agents still working'`, { what: 'idle' });
        assert.equal(await page.ev(`document.getElementById('ask').hidden`), true);
    },

    'header shows the branch chip, amber on main of a work repo, with the unpushed count': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('c-branch').textContent === 'main'`, { what: 'the branch chip' });
        assert.equal(await page.ev(`document.getElementById('c-branch').classList.contains('warn')`), true);
        await page.waitFor(`document.getElementById('c-unpushed').textContent === '1 unpushed' && !document.getElementById('c-unpushed').hidden`, { what: 'the unpushed count' });
    },

    'a stuck turn says so and offers Restart chat behind the confirm': async ({ page, open, IDS, answerPosts }) => {
        await open({ chat: IDS.worker });
        page.route = q => (q.url.includes('/api/transcript') ? { status: 200, body: JSON.stringify({ items: [], working: false, stuck: true, asking: null }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        await page.waitFor(`${status} === 'c-status stuck | No activity for 30 min — Claude may be stuck'`, { what: 'the stuck status' });
        assert.equal(await page.ev(`document.getElementById('status-restart').hidden`), false);
        await page.click('#status-restart');
        await page.waitFor(`document.getElementById('restart-dlg').open`, { what: 'the confirm' });
        assert.deepEqual(page.posts.filter(p => new URL(p.url).pathname === '/api/restart'), []);
    },

    'status bar: working, with the queued message': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        await page.waitFor(`${status}.startsWith('c-status working | Claude is working…')`, { what: 'working' });
        await page.waitFor(`[...document.querySelectorAll('#feed .bubble.user')].some(b => b.textContent.includes('also update the docs') && b.querySelector('.b-note')?.textContent.startsWith('queued'))`, { what: 'the queued bubble' });
        assert.equal(await page.ev(`document.querySelector('#feed .replies')`), null, 'no quick replies while working');
    },

    'status bar: asking, with the question and its options': async ({ page, open, IDS }) => {
        await open({ tracked: '["beta"]', project: 'beta', chat: IDS.asker }); // only beta: the title counts every tracked project
        await page.waitFor(`${status} === 'c-status asking | Claude is asking — see the question above'`, { what: 'asking' });
        assert.equal(await page.ev(`document.getElementById('ask').hidden`), false);
        // not in tmux (no pane to answer on): the transcript's question, its options read-only
        await page.waitFor(`document.getElementById('ask-q').textContent === 'Which database should be the default?'`, { what: 'the question' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#ask-opts .c-opt')].map(l => l.tagName + ' ' + l.firstChild.textContent)`), ['DIV Postgres', 'DIV SQLite']);
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
        await page.waitFor(`${opts}.length === 3`, { what: 'the option buttons' });
        assert.deepEqual(await page.ev(`${opts}.map(b => [b.firstChild.textContent, b.querySelector('small')?.textContent, b.querySelector('.rec')?.textContent, b.getAttribute('variant'), b.getAttribute('appearance')])`),
            [['SQLite', 'file based', 'Recommended', 'brand', 'accent'], ['Postgres', 'from the pane', null, 'neutral', 'outlined'], ['Chat about this', null, null, 'neutral', 'plain']],
            'Type something left out; the recommended one is primary, Chat about this quiet and last');
        await page.ev(`${opts}[1].click()`);
        await page.waitFor(`document.getElementById('ask').hidden`, { what: 'the card gone once the pane has no question, though the transcript still asks it' });
        const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
        assert.deepEqual([u.searchParams.get('tmux'), u.searchParams.get('option'), u.searchParams.get('label')], [`cc-${IDS.asker.slice(0, 8)}`, '1', 'Postgres']);
    },

    '"Chat about this" selects that entry on the pane and focuses the chat input': async ({ page, open, IDS, answerPosts }) => {
        await open({ project: 'beta', chat: IDS.asker });
        let question = { question: 'Which database should be the default?', options: ['SQLite', 'Postgres', 'Type something.', 'Chat about this'], descriptions: ['', '', '', ''], selected: 0 };
        page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
            ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
            : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
        const chat = `[...document.querySelectorAll('#ask-opts wa-button')].at(-1)`;
        await page.waitFor(`${chat}?.firstChild.textContent === 'Chat about this'`, { what: 'the Chat about this button' });
        await page.ev(`${chat}.click()`);
        await page.waitFor(`document.activeElement === document.getElementById('msg')`, { what: 'the chat input focused' });
        const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
        assert.deepEqual([u.searchParams.get('option'), u.searchParams.get('label')], ['3', 'Chat about this']);
    },

    '"Chat about this" declines the question when the pane has no such entry': async ({ page, open, IDS, answerPosts }) => {
        await open({ project: 'beta', chat: IDS.asker });
        let question = { question: 'Which database should be the default?', options: ['SQLite', 'Postgres'], descriptions: ['', ''], selected: 0 };
        page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
            ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
            : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
        const chat = `[...document.querySelectorAll('#ask-opts wa-button')].at(-1)`;
        await page.waitFor(`${chat}?.firstChild.textContent === 'Chat about this'`, { what: 'the fallback button' });
        await page.ev(`${chat}.click()`);
        await page.waitFor(`document.activeElement === document.getElementById('msg')`, { what: 'the chat input focused' });
        assert.ok(page.posts.find(p => p.url.includes('/api/question')).url.includes('dismiss=1'), 'Esc, as Decline does');
    },

    'the ask card shows the current question\'s options, not a previous one\'s': async ({ page, open, IDS, answerPosts }) => {
        const asking = (question, options) => ({ items: [], working: false, asking: question, questions: [{ question, options, descriptions: options.map(() => '') }] });
        let transcript = asking('Which database should be the default?', ['Postgres', 'SQLite']);
        let question = null; // no pane: the transcript's options, read-only
        await open({ project: 'beta', chat: IDS.asker });
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify(transcript), headers: { 'content-type': 'application/json' } }
            : q.url.includes('/api/question') && q.method !== 'POST' ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : answerPosts(q));
        const opts = `[...document.querySelectorAll('#ask-opts .c-opt')].map(b => b.firstChild.textContent)`;
        await page.waitFor(`JSON.stringify(${opts}) === '["Postgres","SQLite"]'`, { what: 'the first question\'s options' });
        transcript = asking('Which port?', ['4478', '8080']);
        await page.waitFor(`document.getElementById('ask-q').textContent === 'Which port?' && JSON.stringify(${opts}) === '["4478","8080"]'`, { what: 'the next question replacing them' });
        question = { question: 'Which port?', options: ['8080', '4478'], descriptions: ['', ''], selected: 0 }; // the pane, as answerable buttons
        await page.waitFor(`JSON.stringify(${opts}) === '["8080","4478","Chat about this"]' && document.querySelectorAll('#ask-opts wa-button').length === 3`, { what: 'the pane\'s buttons' });
    },

    'a permission prompt gets its options as buttons, with the command under the question': async ({ page, open, IDS, answerPosts }) => {
        const transcript = { items: [], working: false, asking: 'Claude needs your permission to use Bash' }; // the hook's text, no options
        let question = parseQuestion(readFileSync(new URL('../fixtures/permission-bash.txt', import.meta.url), 'utf8'));
        await open({ project: 'beta', chat: IDS.asker });
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify(transcript), headers: { 'content-type': 'application/json' } }
            : q.url.includes('/api/question') && q.method !== 'POST' ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
        const opts = `[...document.querySelectorAll('#ask-opts wa-button')]`;
        await page.waitFor(`${opts}.length === 4`, { what: 'the four permission options' });
        assert.equal(await page.ev(`document.getElementById('ask-q').textContent`), 'Bash command · Write and remove a test file · Do you want to proceed?');
        assert.deepEqual(await page.ev(`[document.getElementById('ask-detail').textContent, document.getElementById('ask-more').hidden, document.getElementById('ask').classList.contains('risky')]`),
            ['echo hi > out-from-test.txt && rm out-from-test.txt', true, false]);
        assert.deepEqual(await page.ev(`${opts}.map(b => [b.firstChild.textContent, b.getAttribute('appearance')])`), [
            ['Yes', 'outlined'], ['No', 'outlined'],
            ["Yes, and don't ask again for echo hi and rm out-from-test.txt commands in /private/tmp/claude-501/scratch-projects-some-long-folder-name-to-wrap-it-x/0123456789abcdef-4f82c6fe07ad/scratchpad/perm", 'plain'],
            ['Yes, and switch to auto mode · auto mode handles these prompts for you', 'plain']
        ], 'Yes and No the big pair; the standing grants quiet, last, with their whole scope');
        await page.ev(`${opts}[1].click()`);
        await page.waitFor(`document.getElementById('ask').hidden`, { what: 'the card gone once answered' });
        const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
        assert.deepEqual([u.searchParams.get('option'), u.searchParams.get('label')], ['3', 'No']);
    },

    'a long risky command is shown, its first lines then the rest on demand, on a red card': async ({ page, open, IDS, answerPosts }) => {
        const transcript = { items: [], working: false, asking: 'Claude needs your permission to use Bash' };
        const question = parseQuestion(readFileSync(new URL('../fixtures/permission-bash-long.txt', import.meta.url), 'utf8'));
        await open({ project: 'beta', chat: IDS.asker });
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify(transcript), headers: { 'content-type': 'application/json' } }
            : q.url.includes('/api/question') && q.method !== 'POST' ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : answerPosts(q));
        await page.waitFor(`!document.getElementById('ask-detail').hidden`, { what: 'the command' });
        const detail = `document.getElementById('ask-detail').textContent`, more = `document.getElementById('ask-more')`;
        assert.equal(await page.ev(`${detail}.split('\\n').length`), 6);
        assert.deepEqual(await page.ev(`[${more}.hidden, ${more}.textContent, document.getElementById('ask').classList.contains('risky')]`), [false, '+2 more lines', true]);
        await page.ev(`${more}.click()`);
        assert.equal(await page.ev(detail), question.detail, 'expanded: the whole command, up to the merge');
        assert.equal(await page.ev(`${more}.hidden`), true);
    },

    'a command that changed since the card drew is refused, and the card shows the new one': async ({ page, open, IDS, answerPosts }) => {
        const transcript = { items: [], working: false, asking: 'Claude needs your permission to use Bash' };
        const pane = readFileSync(new URL('../fixtures/permission-bash.txt', import.meta.url), 'utf8');
        const shown = parseQuestion(pane), swapped = parseQuestion(pane.replace('\n echo hi > out-from-test.txt && rm out-from-test.txt\n', '\n git push --force origin main\n'));
        let question = shown;
        await open({ project: 'beta', chat: IDS.asker });
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify(transcript), headers: { 'content-type': 'application/json' } }
            : q.url.includes('/api/question') && q.method !== 'POST' ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : q.url.includes('/api/question') ? (question = swapped, { status: 409, body: 'The command changed — check it again' }) : answerPosts(q));
        const yes = `[...document.querySelectorAll('#ask-opts wa-button')].find(b => b.firstChild.textContent === 'Yes')`;
        await page.waitFor(`${yes} && document.getElementById('ask-detail').textContent.startsWith('echo hi')`, { what: 'the first command' });
        await page.ev(`${yes}.click()`);
        await page.waitFor(`document.getElementById('c-err').textContent === 'The command changed — check it again'`, { what: 'the refusal' });
        await page.waitFor(`document.getElementById('ask-detail').textContent === 'git push --force origin main' && document.getElementById('ask').classList.contains('risky')`, { what: 'the new command, re-rendered' });
        assert.equal(new URL(page.posts.find(p => p.url.includes('/api/question')).url).searchParams.get('seen'), seenHash(shown), 'the hash of what was shown');
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
