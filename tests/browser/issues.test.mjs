import assert from 'node:assert/strict';

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
        assert.equal(await page.ev(`document.getElementById('tab-free').textContent`), '1 unassigned');
        assert.equal(await page.ev(`document.querySelector('#issues .is-big').textContent`), '4 open of 5');
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
        await page.ev(`(() => { const p = document.getElementById('project'); p.value = 'beta'; p.dispatchEvent(new Event('change')); })()`);
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick')?.textContent.includes('No milestones')`, { what: 'the beta pill' });
        await new Promise(r => setTimeout(r, 2500)); // past alpha's delayed answer
        assert.equal(await page.ev(`document.querySelector('#milestone-slot .ms-pick summary').textContent`), '⚑No milestones');
        assert.equal(await page.ev(`document.querySelectorAll('#issues .card').length`), 0, 'no alpha issue cards');
        assert.match(await page.ev(`document.querySelector('#issues .welcome')?.textContent`), /^No open milestones in beta\./);
    }
};
