import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MR, IDS } from './fixture.mjs';
import { sleep } from './cdp.mjs';

const row = key => `document.querySelector('#masters tr[data-key="${key}"]')`;
const groups = `Object.fromEntries([...document.querySelectorAll('#masters .group')].map(g => [g.className.match(/g-([\\w-]+)/)[1], [...g.querySelectorAll('tr[data-key]')].map(r => r.dataset.key)]))`;

export default {
    'a forge that cannot be reached says so once on the board, in plain words': async ({ page, open }) => {
        await open({ project: 'gamma' });
        await page.waitFor(`document.querySelector('#masters .forge-note.err')`, { what: 'the forge line for gamma' });
        assert.equal(await page.ev(`document.querySelectorAll('#masters .forge-note.err').length`), 1);
        assert.doesNotMatch(await page.ev(`document.getElementById('masters').textContent`), /401|Unauthorized|fixture/, 'no CLI text in the page');
        await open();
        assert.equal(await page.ev(`document.querySelector('#masters .forge-note.err')`), null, 'alpha is reachable');
    },

    'closing a row\'s detail leaves the chat where it is': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(102))} && ${row(MR(106))}`, { what: 'the rows' });
        const chat = `localStorage.getItem('chat')`, mine = await page.ev(chat);
        // a row of another session: opening it binds the chat there
        let key = null;
        for (const k of [MR(103), MR(107), MR(106), MR(102), MR(101), MR(105)]) {
            await page.ev(`${row(k)}.click()`);
            await page.waitFor(`import('/core.js').then(m => m.state.selected === ${JSON.stringify(k)})`, { what: `row ${k} selected` });
            if (await page.ev(chat) !== mine) {
                key = k;
                break;
            }
        }
        assert.ok(key, 'the fixture has a row of another session');
        await page.ev(`import('/chat.js').then(m => m.bindChat(${JSON.stringify(mine)}))`); // back to my chat, the row still open
        await page.ev(`${row(key)}.click()`);
        await page.waitFor(`import('/core.js').then(m => m.state.selected === null)`, { what: 'the detail to close' });
        assert.equal(await page.ev(chat), mine);
    },

    'a scrolled board stays where it is when a row is opened and across its own redraws': async ({ page, open }) => {
        await open();
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 420, deviceScaleFactor: 1, mobile: false });
        try {
            const m = `document.getElementById('masters')`, last = `[...document.querySelectorAll('#masters tr[data-key]')].filter(r => r.checkVisibility()).at(-1)`;
            await page.waitFor(`${m}.scrollHeight > ${m}.clientHeight + 50`, { what: 'a board taller than its pane' });
            await page.ev(`${m}.scrollTop = ${m}.scrollHeight`);
            const key = await page.ev(`(${last}.focus({ preventScroll: true }), ${last}.dataset.key)`);
            const before = await page.ev(`${m}.scrollTop`);
            assert.ok(before > 50, 'scrolled down');
            await page.key('Enter', 'Enter');
            await sleep(300);
            assert.ok(await page.ev(`${m}.scrollTop`) >= before, 'opening the last row does not jump to the top');
            assert.equal(await page.ev(`document.activeElement?.dataset?.key ?? null`), key, 'the row keeps focus');
            await page.key('Enter', 'Enter');
            await sleep(300);
            await page.ev(`${m}.scrollTop = ${m}.scrollHeight`);
            const at = await page.ev(`${m}.scrollTop`);
            await sleep(4000); // past a poll redraw
            assert.equal(await page.ev(`${m}.scrollTop`), at, 'a poll redraw keeps the position');
            assert.equal(await page.ev(`document.activeElement?.dataset?.key ?? null`), key, 'and the focused row');
        } finally {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        }
    },

    'work rows land in the right groups': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(102))} && ${row(MR(106))}`, { what: 'the !102 row and the forge-seeded !106' });
        assert.deepEqual(await page.ev(groups), {
            'needs-you': ['agent-stopped', MR(104), `asking:${IDS.master}`], // the master's last reply asks for a decision
            reviews: [MR(201), MR(202)].map(u => `review:${u}`), // newest first; my own !102 is dropped
            doing: [MR(101), MR(105), `starting:${IDS.worker}:7`], // placeholders after the item rows
            review: [MR(103), MR(107), MR(106)],
            ready: [MR(102)],
            finished: ['agent-notes'],
            done: [MR(100)]
        });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#masters .g-head')].map(h => h.textContent)`),
            ['Needs you · 3', 'Review requested · 2', 'Doing · 3', 'In review (3)', 'Ready to merge · 1', 'Recently finished (1)', 'Merged (1)']);
        assert.match(await page.ev(`${row('agent-stopped')}.querySelector('.next').textContent`), /^Next: No output for \d+m — may still be working/);
        assert.equal(await page.ev(`${row('agent-stopped')}.querySelector('.act-btn').textContent`), 'Continue');
        assert.equal(await page.ev(`${row(`asking:${IDS.master}`)}.querySelector('b').textContent.trim()`), 'Should I tag the release now or wait for QA?', 'the needs-you title is what the reply asks');
        assert.match(await page.ev(`${row(`asking:${IDS.master}`)}.querySelector('.next').textContent`), /^alpha · Login work · \w+( ago)?$/);
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.next').textContent`), "💬 1 Next: Reply to Ann Reviewer's comment");
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.act-btn').textContent`), 'Fix & reply');
        assert.equal(await page.ev(`${row(MR(102))}.querySelector('.act-btn').textContent`), 'Merge + close issue');
        await page.waitFor(`!${row(MR(101))}.querySelector('.ms-tag')`, { what: 'no milestone tag while the pill has Sprint 12 picked' });
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('a.chip').textContent`), '!101', 'an open MR shows no "open"');
    },

    'review requested rows show the MR facts and open it in GitLab': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(`review:${MR(201)}`)}`, { what: 'the review-requested row' });
        const txt = await page.ev(`${row(`review:${MR(201)}`)}.textContent`);
        assert.match(txt, /Refactor the tax lookup.*!201.*acme\/alpha.*Ann Reviewer.*2h/);
        assert.ok(await page.ev(`!!${row(`review:${MR(201)}`)}.querySelector('.ci-success')`), 'pipeline shown');
        assert.match(await page.ev(`${row(`review:${MR(202)}`)}.textContent`), /draft/);
        await page.ev(`window.open = (u, t) => { window.__opened = [u, t]; }; ${row(`review:${MR(201)}`)}.click()`);
        assert.deepEqual(await page.ev(`window.__opened`), [MR(201), '_blank']);
        // never side-scrolls, also at phone width
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
        try {
            await page.click('#ptabs [data-pane="work"]');
            await page.waitFor(`document.scrollingElement.scrollWidth <= innerWidth && ${row(`review:${MR(201)}`)}.getBoundingClientRect().right <= innerWidth`, { what: 'no side-scroll at 390px' });
            if (process.env.HOMEBASE_SHOT) {
                writeFileSync(process.env.HOMEBASE_SHOT, Buffer.from((await page.cmd('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
            }
        } finally {
            await page.click('#ptabs [data-pane="chat"]');
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        }
    },

    'in All my projects each row names its project': async ({ page, open }) => {
        await open({ project: 'all' });
        await page.waitFor(`${row(MR(101))} && ${row('https://github.com/acme/beta/pull/7')}`, { what: 'alpha and beta rows' });
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('b .s-proj').textContent`), 'alpha');
        assert.equal(await page.ev(`${row('https://github.com/acme/beta/pull/7')}.querySelector('b .s-proj').textContent`), 'beta');
        await open();
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('.s-proj')`), null, 'not with one project picked');
    },

    'an open MR only the forge lists (never in a transcript) is a row bound to the project\'s newest session': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(106))}`, { what: 'the forge-only !106 row' });
        assert.equal(await page.ev(`${row(MR(106))}.querySelector('.next').textContent`), 'Next: Waiting for review by Ann Reviewer');
    },

    'an MR only items.json remembers is a row, bound to its stored session': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(107))}`, { what: 'the stored-only !107 row' });
        assert.equal(await page.ev(`${row(MR(107))}.querySelector('.next').textContent`), 'Next: Needs a reviewer');
    },

    'a gate subagent links through the turn that spawned it, so its approved MR has no Merge button': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters .g-doing tr[data-key="${MR(105)}"]')`, { what: 'the !105 row in Doing' });
        assert.match(await page.ev(`${row(MR(105))}.querySelector('.next').textContent`), /^Now: running git( · for \d+m)?$/, 'what the agent does now');
        assert.equal(await page.ev(`${row(MR(105))}.querySelector('.act-btn')`), null, 'no Merge button');
    },

    'badges: CI, comments and review gate': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(101))}?.querySelector('.cm-badge')`, { what: 'the comment badge on !101' });
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('.cm-badge').textContent`), '💬 1');
        const ci = key => page.ev(`[...${row(key)}.querySelectorAll('.pr .ci-pill')].map(p => p.className + ' ' + p.textContent).join()`);
        assert.equal(await ci(MR(101)), 'ci-pill ci-failed ✗');
        assert.equal(await ci(MR(102)), 'ci-pill ci-success ✓');
        assert.equal(await ci(MR(103)), 'ci-pill ci-running ●');
        assert.equal(await page.ev(`${row(MR(102))}.querySelector('.gate-badge').className + ' ' + ${row(MR(102))}.querySelector('.gate-badge').textContent`), 'gate-badge gate-ready ✓ gate');
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('.gate-badge')`), null, 'no gate where none ran');
        // a window too narrow for the MR column keeps the pipeline mark, beside the title
        const beside = `${row(MR(101))}.querySelector('.what .ci-pill.ci-failed').checkVisibility()`;
        assert.equal(await page.ev(beside), false, 'not twice on a wide board');
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
        try {
            await page.waitFor(beside, { what: 'the pipeline mark beside the title', timeout: 3000 });
        } finally {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
        }
    },

    'a chat only the hook marker says is asking gets a Needs you row that opens it': async ({ page, open, homebase }) => {
        // worker's transcript shows an open turn and no question (the late-write case); only hooks/asking.mjs's marker knows
        const dir = join(homebase, 'asking'), file = join(dir, `${IDS.worker}.json`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, JSON.stringify({ questions: [{ question: 'Merge !101 now?', options: ['Yes', 'No'] }], toolUseId: 'q1', at: new Date().toISOString() }));
        try {
            await open();
            const ask = row(`asking:${IDS.worker}`);
            await page.waitFor(`document.querySelector('#masters .g-needs-you tr[data-key="asking:${IDS.worker}"]')`, { what: 'the asking row in Needs you' });
            assert.equal(await page.ev(`${ask}.querySelector('b').textContent.trim()`), 'Refactor the session store is asking');
            assert.equal(await page.ev(`${ask}.querySelector('.next').textContent`), 'Merge !101 now? · click to answer in the chat');
            assert.equal(await page.ev(`document.querySelector('#masters .g-needs-you .g-head').textContent`), 'Needs you · 4');
            await page.click(`#masters tr[data-key="asking:${IDS.worker}"]`);
            await page.waitFor(`document.getElementById('status-text').textContent.startsWith('Claude is asking')`, { what: 'the chat status to say asking' });
            assert.equal(await page.ev(`document.getElementById('c-back').hidden`), false);
            await page.waitFor(`/Merge !101 now\\?/.test(document.getElementById('ask-q').textContent)`, { what: 'the question in the card' });
            assert.match(await page.ev('document.title'), /^\(\d+\) Homebase$/);
        } finally {
            rmSync(file, { force: true });
        }
    },

    'a working main chat shows in Doing with its Now line, opens its chat, and leaves when idle': async ({ page, open }) => {
        // the poll answers are patched: the idle master (alpha) works on a step for 2 minutes, until window.idle is set
        await open({ chat: IDS.worker });
        await page.ev(`(() => { window.t0 = Date.now(); const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o); if (!String(u).startsWith("/api/sessions")) return r; const j = await r.json(); for (const s of j) if (s.id === "${IDS.master}" && !window.idle) { Object.assign(s, { status: 'working', asking: false, needsYou: false, needsText: null, step: 'running npm test', now: 'Check the newest request', stepAt: window.t0 - 125_000, since: window.t0 - 300_000 }); } return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }); }; })()`);
        const key = `working:${IDS.master}`;
        await page.waitFor(`document.querySelector('#masters .g-doing tr[data-key="${key}"]')`, { what: 'the main chat row in Doing' });
        assert.equal(await page.ev(`${row(key)}.querySelector('b').textContent.trim()`), 'Check the newest request main chat', 'the newest request, not the first prompt or the session title');
        assert.equal(await page.ev(`${row(key)}.querySelector('.next').textContent`), 'alpha · Now: running npm test · for 2m');
        assert.equal(await page.ev(`!!document.querySelector('#masters tr[data-key="asking:${IDS.master}"]')`), false, 'working, so not in Needs you');
        await page.click(`#masters tr[data-key="${key}"]`);
        await page.waitFor(`!document.getElementById('c-back').hidden`, { what: 'the master chat to open with a way back' });
        await page.ev(`window.idle = true`);
        await page.waitFor(`!document.querySelector('tr[data-key="${key}"]')`, { what: 'the row to leave Doing once idle' });
    },

    'Recently finished is folded until opened': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters .group.g-finished')`, { what: 'the finished group' });
        assert.equal(await page.ev(`document.querySelector('.group.g-finished').hasAttribute('open')`), false);
        assert.equal(await page.ev(`${row('agent-notes')}.checkVisibility()`), false, 'its row is hidden');
        await page.click('.group.g-finished .g-head');
        await page.waitFor(`${row('agent-notes')}.checkVisibility()`, { what: 'the row to show' });
        assert.equal(await page.ev(`localStorage.getItem('fold:finished:alpha')`), 'open');
    },

    'a reload never paints a closed Recently finished with its rows showing': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters .group.g-finished')`, { what: 'the finished group' });
        // from the first frame of the reloaded page, note every frame where a closed finished group shows a row (also before wa-details is defined)
        await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__shown = 0;
            const tick = () => { const g = document.querySelector('.group.g-finished'); if (g && !g.open && !g.hasAttribute('open') && [...g.querySelectorAll('tr')].some(r => r.checkVisibility())) window.__shown++; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);` });
        await page.cmd('Page.reload', {});
        await page.waitFor(`customElements.get('wa-details') && document.querySelector('#masters .group.g-finished')`, { what: 'the finished group after the reload' });
        await page.ev(`new Promise(r => setTimeout(r, 500))`);
        assert.equal(await page.ev(`window.__shown`), 0, 'frames with a closed group showing rows');
    },

    'In review folds per project when chosen, with its count': async ({ page, open }) => {
        await open({ 'fold:review:alpha': 'closed' });
        await page.waitFor(`document.querySelector('#masters .group.g-review')`, { what: 'the review group' });
        assert.equal(await page.ev(`document.querySelector('.group.g-review').hasAttribute('open')`), false);
        assert.equal(await page.ev(`${row(MR(103))}.checkVisibility()`), false, 'its rows are hidden');
        await page.click('.group.g-review .g-head');
        await page.waitFor(`${row(MR(103))}.checkVisibility()`, { what: 'the rows to show' });
        assert.equal(await page.ev(`localStorage.getItem('fold:review:alpha')`), 'open');
    },

    'Dismiss puts away a row without an MR on every device, until its helper works again': async ({ page, open, IDS, homebase, answerPosts }) => {
        const file = join(dirname(homebase), 'home', '.claude', 'projects', '-fx-alpha', IDS.master, 'subagents', 'agent-stopped.jsonl');
        const was = statSync(file).mtime, button = `${row('agent-stopped')}?.querySelector('wa-button[aria-label="Dismiss"]')`;
        await open();
        await page.waitFor(`${button} && ${row(MR(104))}`, { what: 'the stopped helper with its Dismiss button' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#masters wa-button[aria-label="Dismiss"]')].map(b => b.closest('tr').dataset.key)`), ['agent-stopped', 'agent-notes'],
            'only on the rows with no MR whose helper is not working: the stopped one and the finished one');
        assert.ok(await page.ev(`(() => { const b = ${button}.getBoundingClientRect(), td = ${button}.closest('td').getBoundingClientRect(); return b.width > 0 && b.left >= td.left && b.right <= td.right; })()`), 'it fits its cell');
        assert.equal(await page.ev(`${button}.title || ${button}.getAttribute('title')`), 'Dismiss', 'its tooltip');
        try {
            page.route = q => (q.url.includes('/api/dismissed') ? null : answerPosts(q)); // this POST only writes the fixture's dismissed.json
            await page.clickOn(button);
            await page.waitFor(`!${row('agent-stopped')}`, { what: 'the row gone' });
            assert.equal(await page.ev(`import('/core.js').then(m => m.state.selected)`), null, 'dismissing does not open the row');
            assert.deepEqual(JSON.parse(readFileSync(join(homebase, 'dismissed.json'), 'utf8')).map(e => e[0]), ['agent-stopped']);
            await open(); // another load, as another device: the server leaves it out
            assert.deepEqual(await page.ev(`import('/core.js').then(m => m.api('/api/sessions')).then(r => r.json()).then(l => l.flatMap(s => s.items).filter(i => i.key === 'agent-stopped'))`), [], 'the server no longer lists it');
            await page.waitFor(`${row(MR(104))} && !${row('agent-stopped')}`, { what: 'the board without it after a reload' }); // the first draw may be the tab's cached list
            await sleep(2000); // and it stays away over the next polls
            assert.equal(await page.ev(`!!${row('agent-stopped')}`), false, 'still gone');
            utimesSync(file, new Date(), new Date()); // a new message resumed the helper: its transcript moves
            await page.waitFor(row('agent-stopped'), { what: 'the row back once its helper works again' });
        } finally {
            utimesSync(file, was, was);
        }
        await page.waitFor(button, { what: 'the helper stopped again, and its row staying' });
    },

    'Step in opens a helper\'s own messages in the chat pane, Back returns': async ({ page, open, IDS }) => {
        const step = `${row('agent-stopped')}?.querySelector('wa-button.step-in')`;
        await open();
        await page.waitFor(step, { what: 'the helper row with its Open chat icon' });
        assert.deepEqual(await page.ev(`[${step}.getAttribute('aria-label'), ${step}.title]`), ['Open chat', 'Open chat']);
        await page.clickOn(step);
        await page.waitFor(`document.getElementById('feed').textContent.includes('Find out why the auth test is flaky')`, { what: "the helper's own message in the feed" });
        assert.equal(await page.ev(`document.getElementById('c-focus').textContent`), 'Helper: Investigate flaky test');
        assert.match(await page.ev(`document.getElementById('c-back').textContent`), /^← Back to /);
        assert.match(await page.ev(`document.getElementById('msg').getAttribute('placeholder')`), /^Message goes to this helper via its main chat$/);
        assert.equal(await page.ev(`location.hash`), `#chat=${IDS.master}&agent=agent-stopped`, 'deep link');
        await page.clickOn(`document.getElementById('c-back')`);
        await page.waitFor(`document.getElementById('c-back').hidden && !document.getElementById('feed').textContent.includes('Find out why the auth test is flaky') && location.hash === ''`, { what: 'the chat back' });
    }
};
