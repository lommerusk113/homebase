import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseQuestion } from '../../server/startup.mjs';
import { seenHash } from '../../public/core.js';
import { sleep } from './cdp.mjs';

const status = `document.getElementById('status').className + ' | ' + document.getElementById('status-text').textContent`;

export default {
    'the chat card shows the branch chip with the unpushed count': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.getElementById('c-branch').textContent === 'main'`, { what: 'the branch chip' });
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

    'old rules: the strip names the files, Restart chat opens the confirm, Dismiss hides it until a file changes again': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        // the fixture has no registry, so mark the bound session stale in the polled list
        await page.ev(`(() => { window.rulesAt = 100; const f = window.fetch; window.fetch = async (u, o) => { if (String(u).startsWith('/api/rules/seen')) window.seen = JSON.parse(o.body).at; const r = await f(u, o); if (!String(u).startsWith('/api/sessions')) return r; const j = await r.json(); for (const s of j) if (s.id === '${IDS.worker}' && !(window.seen >= window.rulesAt)) { s.rulesStale = ['homebase-rules.md', 'CLAUDE.md']; s.rulesAt = window.rulesAt; } return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }); }; })()`);
        const strip = `document.getElementById('rules')`;
        await page.waitFor(`!${strip}.hidden`, { what: 'the strip' });
        assert.equal(await page.ev(`${strip}.textContent`), 'New rules since this chat startedLoad new rulesRestart chat×');
        assert.equal(await page.ev(`${strip}.title`), 'Changed: homebase-rules.md, CLAUDE.md');
        assert.ok(await page.ev(`document.querySelector('.pp-row[data-value="alpha"] small').textContent.includes('old rules')`), 'picker row tag');
        await page.click('#rules-restart');
        await page.waitFor(`document.getElementById('restart-dlg').open`, { what: 'the confirm' });
        await page.ev(`document.getElementById('restart-dlg').open = false`);
        await page.waitFor(`!document.getElementById('restart-dlg').open`, { what: 'the confirm closed' });
        await page.click('#rules-dismiss');
        await page.waitFor(`${strip}.hidden`, { what: 'dismissed' });
        await page.ev(`window.rulesAt = 200`);
        await page.waitFor(`!${strip}.hidden`, { timeout: 15_000, what: 'back after a file changed again' });
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
        await page.waitFor(`document.getElementById('ask-q').textContent === 'Which database should be the default?'`, { what: 'the question' });
        assert.equal(await page.ev(`document.getElementById('ask-cmd').textContent`), `tmux attach -t cc-${IDS.asker.slice(0, 8)}`);
        await page.waitFor(`document.title === '(1) Homebase'`, { what: 'the title count' });
    },

    'no question readable on the pane: an option still answers by a real click, typed as a message naming the question': async ({ page, open, IDS }) => {
        await open({ project: 'beta', chat: IDS.asker });
        const opts = `[...document.querySelectorAll('#ask-opts wa-button.c-opt')]`;
        await page.waitFor(`${opts}.length === 2`, { what: "the transcript's options as buttons" });
        assert.deepEqual(await page.ev(`${opts}.map(b => b.firstChild.textContent)`), ['Postgres', 'SQLite']);
        await sleep(1700); // a poll passes: the buttons are the same nodes
        await page.clickOn(`${opts}[1]`);
        await page.waitFor(`document.getElementById('ask').hidden`, { what: 'the card gone once answered' });
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')).map(p => [new URL(p.url).searchParams.get('id'), p.body]),
            [[IDS.asker, 'SQLite\n\n(Answering your question: "Which database should be the default?")']]);
    },

    'a tall question card scrolls in its own room: every option takes a real click and the input stays on screen': async ({ page, open, IDS, answerPosts }) => {
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false });
        try {
            await open({ project: 'beta', chat: IDS.asker });
            const text = 'Which icon should Homebase use on the phone home screen, in the browser tab and in the dock? All four work in light and dark, so this is purely a matter of taste and I would rather not pick one for you. '.repeat(2).trim();
            let question = { question: text, options: ['Home light (Recommended)', 'Orbit', 'Task house', 'Diamond', 'Type something.', 'Chat about this'], descriptions: ['A small house with a lit window: reads as Homebase at 16px and keeps its shape on a dark dock.', 'A dot circled by two smaller dots: says orchestration, anonymous at small sizes.', 'A house whose door is a check mark: says tasks, a bit busy at 16px.', 'A plain rotated square in the accent colour: the calmest, also the most generic.', '', ''], selected: 0 };
            page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
                ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
            const opts = `[...document.querySelectorAll('#ask-opts wa-button.c-opt')]`;
            await page.waitFor(`${opts}.length === 5`, { what: 'the option buttons' });
            assert.equal(await page.ev(`document.getElementById('msg').getBoundingClientRect().bottom <= innerHeight`), true, 'the input is on screen');
            await page.clickOn(`${opts}[3]`); // the last described option: scrolled into view inside the cards
            await page.waitFor(`document.getElementById('ask').hidden`, { what: 'the card gone once answered' });
            const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
            assert.deepEqual([u.searchParams.get('option'), u.searchParams.get('label')], ['3', 'Diamond']);
        } finally {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        }
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

    'a question clipped at the top of a small pane shows the transcript\'s whole question': async ({ page, open, IDS, answerPosts }) => {
        await open({ project: 'beta', chat: IDS.asker });
        const question = { question: 'should be the default?', options: ['Postgres', 'SQLite', 'Type something.', 'Chat about this'], descriptions: ['', '', '', ''], selected: 0 };
        page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
            ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } } : answerPosts(q));
        const opts = `[...document.querySelectorAll('#ask-opts wa-button')].map(b => b.firstChild.textContent)`;
        await page.waitFor(`JSON.stringify(${opts}) === '["Postgres","SQLite","Chat about this"]'`, { what: "the pane's buttons" });
        assert.equal(await page.ev(`document.getElementById('ask-q').textContent`), 'Which database should be the default?');
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
        assert.deepEqual(await page.ev(`[document.getElementById('ask-detail').textContent, document.getElementById('ask-more').hidden]`),
            ['echo hi > out-from-test.txt && rm out-from-test.txt', true]);
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

    'a long risky command is shown, its first lines then the rest on demand': async ({ page, open, IDS, answerPosts }) => {
        const transcript = { items: [], working: false, asking: 'Claude needs your permission to use Bash' };
        const question = parseQuestion(readFileSync(new URL('../fixtures/permission-bash-long.txt', import.meta.url), 'utf8'));
        await open({ project: 'beta', chat: IDS.asker });
        page.route = q => (q.url.includes('/api/transcript') ? { body: JSON.stringify(transcript), headers: { 'content-type': 'application/json' } }
            : q.url.includes('/api/question') && q.method !== 'POST' ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
                : answerPosts(q));
        await page.waitFor(`!document.getElementById('ask-detail').hidden`, { what: 'the command' });
        const detail = `document.getElementById('ask-detail').textContent`, more = `document.getElementById('ask-more')`;
        assert.equal(await page.ev(`${detail}.split('\\n').length`), 6);
        assert.deepEqual(await page.ev(`[${more}.hidden, ${more}.textContent]`), [false, '+2 more lines']);
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
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer'`, { what: 'idle first' });
        page.route = q => (q.url.includes('/api/transcript') ? { status: 503, body: 'down' } : answerPosts(q));
        await page.waitFor(`${status} === 'c-status error | Can’t reach Homebase — reconnecting…'`, { what: 'error' });
        page.route = answerPosts;
        await page.waitFor(`${status} === 'c-status idle | Claude needs your answer'`, { what: 'idle again' });
    }
};
