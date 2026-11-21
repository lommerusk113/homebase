import assert from 'node:assert/strict';
import { IDS } from './fixture.mjs';

const lanes = `[...document.querySelectorAll('#issues .lane')].map(l => ({ name: l.querySelector('.name').childNodes[1].textContent, you: !!l.querySelector('.you'), cards: [...l.querySelectorAll('.card')].map(c => c.dataset.key) }))`;

export default {
    'lanes render per person, you first and Unassigned last': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelectorAll('#issues .lane:not(.skel)').length === 3`, { what: 'three lanes' });
        assert.deepEqual(await page.ev(lanes), [
            { name: 'Test', you: true, cards: ['issue:5', 'issue:8'] },
            { name: 'Ann', you: false, cards: ['issue:6'] },
            { name: 'Unassigned', you: false, cards: ['issue:7'] }
        ]);
        assert.equal(await page.ev(`document.querySelector('#issues .is-big').textContent`), '4 open of 5');
    },

    'Assigned to me lists only my open issues across milestones': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelector('#issues .card')`, { what: 'the milestone cards' });
        await page.click('#milestone-slot .ms-pick summary');
        await page.click('#milestone-slot .ms-menu button[data-id="mine"]');
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick summary .t')?.textContent === 'Assigned to me' && document.querySelector('#issues .card[data-key="issue:20"]')`, { what: 'my issues' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#issues .card')].map(c => c.dataset.key)`), ['issue:5', 'issue:8', 'issue:20']);
        assert.equal(await page.ev(`document.querySelector('#issues .card[data-key="issue:20"] .is-ms').textContent`), '⚑ Backlog');
        assert.equal(await page.ev(`document.querySelector('#issues .is-big').textContent`), '3 open of 3');
    },

    'a card expands and collapses': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:6"]')`, { what: 'card #6' });
        assert.equal(await page.ev(`document.querySelector('#issues .card[data-key="issue:6"] .tt').textContent`), 'Add CSV export', 'short title drops the milestone prefix');
        await page.click('#issues .card[data-key="issue:6"]');
        await page.waitFor(`document.querySelector('#issues .card.open[data-key="issue:6"] .more')`, { what: 'the card to open' });
        assert.equal(await page.ev(`document.querySelector('#issues .card.open .desc').textContent`), 'Details for Sprint 12: Add CSV export.');
        assert.equal(await page.ev(`document.querySelector('#issues .card.open .msg code').textContent`), 'Implement #6');
        await page.click('#issues .card[data-key="issue:6"] .tt');
        await page.waitFor(`!document.querySelector('#issues .card.open')`, { what: 'the card to close' });
    },

    'a slow answer for the old project never shows after switching': async ({ page, open, base, answerPosts }) => {
        await open({ tab: 'issues' });
        page.route = q => (q.url.includes('/api/milestones?project=alpha') ? { delay: 1500 } : answerPosts(q));
        await page.goto(base);
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick')?.textContent.includes('Loading')`, { what: 'the alpha pill loading' });
        await page.click('#project');
        await page.click('.pp-row[data-value="beta"]');
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick')?.textContent.includes('No milestones')`, { what: 'the beta pill' });
        await new Promise(r => setTimeout(r, 2500)); // past alpha's delayed answer
        assert.equal(await page.ev(`document.querySelector('#milestone-slot .ms-pick summary').textContent`), '⚑No milestones');
        assert.equal(await page.ev(`document.querySelectorAll('#issues .card').length`), 0, 'no alpha issue cards');
        assert.match(await page.ev(`document.querySelector('#issues .welcome')?.textContent`), /^No open milestones in beta\./);
    },

    'Start on a collapsed card sends Implement #N to the chat and marks it starting': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:6"] .act-btn:not([disabled])')`, { what: 'the enabled Start button' });
        assert.equal(await page.ev(`document.querySelector('#issues .card[data-key="issue:6"] .act-btn').textContent`), 'Start');
        await page.click('#issues .card[data-key="issue:6"] .act-btn');
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:6"] .st').textContent === 'starting…'`, { what: 'the card to say starting' });
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')).map(p => [new URL(p.url).search, p.body]), [[`?id=${IDS.master}&canned=1`, 'Implement #6']]);
        assert.equal(await page.ev(`document.querySelector('#issues .card[data-key="issue:6"]').classList.contains('open')`), false, 'the click did not expand the card');
    },

    'a on an issue card asks first, and only the dialog button sends': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:6"] .act-btn:not([disabled])')`, { what: 'the card' });
        await page.ev(`document.activeElement?.blur(); document.querySelector('#issues .card[data-key="issue:6"]').focus()`);
        await page.key('a');
        await page.waitFor(`document.querySelector('.keys-msg')?.textContent === 'Implement #6'`, { what: 'the confirm dialog' });
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')), []);
    }
};
