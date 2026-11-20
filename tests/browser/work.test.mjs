import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MR, IDS } from './fixture.mjs';

const row = key => `document.querySelector('#masters tr[data-key="${key}"]')`;
const groups = `Object.fromEntries([...document.querySelectorAll('#masters .group:not(.g-sessions)')].map(g => [g.className.match(/g-([\\w-]+)/)[1], [...g.querySelectorAll('tr[data-key]')].map(r => r.dataset.key)]))`;

export default {
    'work rows land in the right groups': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(102))} && ${row(MR(106))}`, { what: 'the !102 row and the forge-seeded !106' });
        assert.deepEqual(await page.ev(groups), {
            'needs-you': ['agent-stopped', MR(104), `asking:${IDS.master}`], // the master's last reply asks for a decision
            doing: [MR(101), MR(105), `starting:${IDS.worker}:7`], // placeholders after the item rows
            review: [MR(103), MR(107), MR(106)],
            ready: [MR(102)],
            finished: ['agent-notes'],
            done: [MR(100)]
        });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#masters .g-head')].map(h => h.textContent)`),
            ['Needs you · 3', 'Doing · 3', 'In review (3)', 'Ready to merge · 1', 'Recently finished (1)', 'Merged (1)']);
        assert.equal(await page.ev(`${row('agent-stopped')}.querySelector('.next').textContent`), 'Next: Agent stopped — check the chat');
        assert.equal(await page.ev(`${row('agent-stopped')}.querySelector('.act-btn').textContent`), 'Continue');
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.next').textContent`), "💬 1 Next: Reply to Ann Reviewer's comment");
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.act-btn').textContent`), 'Fix & reply');
        assert.equal(await page.ev(`${row(MR(102))}.querySelector('.act-btn').textContent`), 'Merge + close issue');
        await page.waitFor(`!${row(MR(101))}.querySelector('.ms-tag')`, { what: 'no milestone tag while the pill has Sprint 12 picked' });
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('a.chip').textContent`), '!101', 'an open MR shows no "open"');
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
        assert.match(await page.ev(`${row(MR(105))}.querySelector('.next').textContent`), /^Now: Gate: code review — running git diff main\.\.\.( · for \dm)?$/, 'what the agent does now');
        assert.equal(await page.ev(`${row(MR(105))}.querySelector('.act-btn')`), null, 'no Merge button');
    },

    'badges: CI, comments and review gate': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(101))}?.querySelector('.cm-badge')`, { what: 'the comment badge on !101' });
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('.cm-badge').textContent`), '💬 1');
        const ci = key => page.ev(`[...${row(key)}.querySelectorAll('.ci-pill')].map(p => p.className + ' ' + p.textContent).join()`);
        assert.equal(await ci(MR(101)), 'ci-pill ci-failed ✗');
        assert.equal(await ci(MR(102)), 'ci-pill ci-success ✓');
        assert.equal(await ci(MR(103)), 'ci-pill ci-running ●');
        assert.equal(await page.ev(`${row(MR(102))}.querySelector('.gate-badge').className + ' ' + ${row(MR(102))}.querySelector('.gate-badge').textContent`), 'gate-badge gate-ready ✓ gate');
        assert.equal(await page.ev(`${row(MR(101))}.querySelector('.gate-badge')`), null, 'no gate where none ran');
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
            assert.equal(await page.ev(`localStorage.getItem('chat')`), IDS.worker);
            await page.waitFor(`/Merge !101 now\\?/.test(document.getElementById('ask-q').textContent)`, { what: 'the question in the card' });
            assert.match(await page.ev('document.title'), /^\(\d+\) Homebase$/);
        } finally {
            rmSync(file, { force: true });
        }
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

    'In review folds per project when chosen, with its count': async ({ page, open }) => {
        await open({ 'fold:review:alpha': 'closed' });
        await page.waitFor(`document.querySelector('#masters .group.g-review')`, { what: 'the review group' });
        assert.equal(await page.ev(`document.querySelector('.group.g-review').hasAttribute('open')`), false);
        assert.equal(await page.ev(`${row(MR(103))}.checkVisibility()`), false, 'its rows are hidden');
        await page.click('.group.g-review .g-head');
        await page.waitFor(`${row(MR(103))}.checkVisibility()`, { what: 'the rows to show' });
        assert.equal(await page.ev(`localStorage.getItem('fold:review:alpha')`), 'open');
    }
};
