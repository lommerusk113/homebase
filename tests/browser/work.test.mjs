import assert from 'node:assert/strict';
import { MR, IDS } from './fixture.mjs';

const row = key => `document.querySelector('#masters tr[data-key="${key}"]')`;
const groups = `Object.fromEntries([...document.querySelectorAll('#masters .group:not(.g-sessions)')].map(g => [g.className.match(/g-([\\w-]+)/)[1], [...g.querySelectorAll('tr[data-key]')].map(r => r.dataset.key)]))`;

export default {
    'work rows land in the right groups': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(102))}`, { what: 'the !102 row' });
        assert.deepEqual(await page.ev(groups), {
            'needs-you': ['agent-stopped', MR(104)],
            doing: [`starting:${IDS.worker}:7`, MR(101), MR(105)],
            review: [MR(103)],
            ready: [MR(102)],
            finished: ['agent-notes'],
            done: [MR(100)]
        });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#masters .g-head')].map(h => h.textContent)`),
            ['Needs you · 2', 'Doing · 3', 'In review · 1', 'Ready to merge · 1', 'Recently finished (1)', 'Merged (1)']);
        assert.equal(await page.ev(`${row('agent-stopped')}.querySelector('.next').textContent`), 'Next: Agent stopped — check the chat');
        assert.equal(await page.ev(`${row('agent-stopped')}.querySelector('.act-btn').textContent`), 'Continue');
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.next').textContent`), "💬 1 Next: Reply to Ann Reviewer's comment");
        assert.equal(await page.ev(`${row(MR(104))}.querySelector('.act-btn').textContent`), 'Fix & reply');
        assert.equal(await page.ev(`${row(MR(102))}.querySelector('.act-btn').textContent`), 'Merge + close issue');
        assert.ok(await page.ev(`${row(MR(101))}.querySelector('.ms-tag').textContent === '⚑ Sprint 12'`), 'milestone tag');
    },

    'a gate subagent links through the turn that spawned it, so its approved MR has no Merge button': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters .g-doing tr[data-key="${MR(105)}"]')`, { what: 'the !105 row in Doing' });
        assert.equal(await page.ev(`${row(MR(105))}.querySelector('.next').textContent`), 'Next: Gate: code review is exploring…');
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

    'Recently finished is folded until opened': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters .group.g-finished')`, { what: 'the finished group' });
        assert.equal(await page.ev(`document.querySelector('.group.g-finished').hasAttribute('open')`), false);
        assert.equal(await page.ev(`${row('agent-notes')}.checkVisibility()`), false, 'its row is hidden');
        await page.click('.group.g-finished .g-head');
        await page.waitFor(`${row('agent-notes')}.checkVisibility()`, { what: 'the row to show' });
        assert.equal(await page.ev(`localStorage.getItem('fold:finished:alpha')`), 'open');
    }
};
