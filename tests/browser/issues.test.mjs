import assert from 'node:assert/strict';
import { IDS } from './fixture.mjs';

const lanes = `[...document.querySelectorAll('#issues .lane')].map(l => ({ name: l.querySelector('.name').childNodes[1].textContent, you: !!l.querySelector('.you'), cards: [...l.querySelectorAll('.card')].map(c => c.dataset.key) }))`;

export default {
    'lanes render per person, you first and Unassigned last': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelectorAll('#issues .lane:not(.skel)').length === 3`, { what: 'three lanes' });
        assert.deepEqual(await page.ev(lanes), [
            { name: 'Test', you: true, cards: ['issue:5', 'issue:8', 'issue:30'] },
            { name: 'Ann', you: false, cards: ['issue:6'] },
            { name: 'Unassigned', you: false, cards: ['issue:7'] }
        ]);
        assert.equal(await page.ev(`document.querySelector('#issues .is-big').textContent`), '5 open of 6');
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

    'a stored milestone and a slow answer show no row outside it before the answer': async ({ page, open, base, answerPosts }) => {
        const keys = `document.querySelectorAll('#masters tr[data-key^="https://"]').length`;
        await open({ 'milestone:alpha': '12' }); // Backlog: no MR of the fixture is in it
        page.route = q => (q.url.includes('/api/milestones?project=alpha') ? { delay: 2500 } : answerPosts(q));
        await page.goto(base);
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick')?.textContent.includes('Loading')`, { what: 'the pill loading' });
        await new Promise(r => setTimeout(r, 1200));
        assert.equal(await page.ev(keys), 0, 'no MR row before the answer');
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick summary .t')?.textContent === 'Backlog'`, { what: 'the answer' });
        assert.equal(await page.ev(keys), 0, 'nor after it');
    },

    'a slow answer for the old project never shows after switching': async ({ page, open, base, answerPosts }) => {
        await open({ tab: 'issues' });
        page.route = q => (q.url.includes('/api/milestones?project=alpha') ? { delay: 1500 } : answerPosts(q));
        await page.goto(base);
        await page.waitFor(`document.querySelector('#milestone-slot .ms-pick')?.textContent.includes('Loading')`, { what: 'the alpha pill loading' });
        await page.click('#project');
        await page.click('.pp-row[data-value="beta"]');
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:4"]')`, { what: "beta's issues" });
        await new Promise(r => setTimeout(r, 2500)); // past alpha's delayed answer
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#issues .card')].map(c => c.dataset.key)`), ['issue:3', 'issue:4'], 'no alpha issue cards');
    },

    'a GitHub project without milestones shows my issues, with its PRs linked and in its own words': async ({ page, open }) => {
        await open({ tab: 'issues', project: 'beta', chat: IDS.asker, 'milestone:beta': 'none' });
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:4"]')`, { what: "beta's issues" });
        assert.equal(await page.ev(`document.getElementById('milestone-slot').hidden`), true, 'no pill: the tab shows them by itself');
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#issues .card')].map(c => [c.dataset.key, c.classList.contains('doing'), !!c.querySelector('a.chip')])`),
            [['issue:3', true, true], ['issue:4', false, false]], 'the issue with an open PR is in progress');
        await page.click('#issues .card[data-key="issue:4"]');
        await page.waitFor(`document.querySelector('#issues .card.open .more')`, { what: 'the open card' });
        assert.doesNotMatch(await page.ev(`document.getElementById('issues').textContent`), /GitLab|\bMRs?\b/, 'a GitHub project never says GitLab or MR');
    },

    'Start on my own issue asks the server for its worktree and chat, and never types into the current chat': async ({ page, open }) => {
        await open({ tab: 'issues' });
        const btn = k => `document.querySelector('#issues .card[data-key="issue:${k}"] .act-btn')`;
        await page.waitFor(`${btn(30)} && !${btn(30)}.disabled`, { what: 'the enabled Start button' });
        assert.equal(await page.ev(`${btn(30)}.textContent`), 'Start');
        await page.click('#issues .card[data-key="issue:30"] .act-btn');
        await page.waitFor(`true`, { what: 'the click' });
        await new Promise(r => setTimeout(r, 300));
        const posts = page.posts.filter(p => p.url.includes('/api/issues/start'));
        assert.deepEqual(posts.map(p => JSON.parse(p.body)), [{ project: 'alpha', iid: 30, manual: false }]);
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')), []);
    },

    'the Manual toggle sits by Start, is remembered per project, and goes with the start request': async ({ page, open }) => {
        await open({ tab: 'issues' });
        const box = '#issues .card[data-key="issue:30"] .manual-toggle input';
        await page.waitFor(`document.querySelector('${box}')`, { what: 'the Manual toggle' });
        assert.equal(await page.ev(`document.querySelector('${box}').checked`), false);
        await page.click(box);
        await page.waitFor(`localStorage.getItem('manual-start:alpha') === '1'`, { what: 'the choice saved' });
        await page.click('#issues .card[data-key="issue:30"] .act-btn');
        await new Promise(r => setTimeout(r, 300));
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/issues/start')).map(p => JSON.parse(p.body)), [{ project: 'alpha', iid: 30, manual: true }]);
    },

    "Start is off for somebody else's issue, and says whose it is": async ({ page, open }) => {
        await open({ tab: 'issues' });
        const btn = `document.querySelector('#issues .card[data-key="issue:6"] .act-btn')`;
        await page.waitFor(`${btn}`, { what: "Ann's card" });
        assert.equal(await page.ev(`${btn}.hasAttribute('disabled')`), true);
        assert.equal(await page.ev(`${btn}.title`), 'Assigned to Ann, only they can start it');
        await page.click('#issues .card[data-key="issue:6"] .act-btn');
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/issues/start') || p.url.includes('/api/send')), []);
    },

    'an issue another chat of the project already took on offers that chat, never a second Implement': async ({ page, open }) => {
        await open({ tab: 'issues' });
        const btn = `document.querySelector('#issues .card[data-key="issue:7"] .act-btn')`;
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:30"] .act-btn:not([disabled])')`, { what: 'the cards' });
        assert.equal(await page.ev(`document.querySelector('#issues .card[data-key="issue:7"]').dataset.msg ?? null`), null, 'the a key has nothing to send');
        await page.click('#issues .card[data-key="issue:7"] .act-btn');
        await page.waitFor(`localStorage.getItem('chat') === '${IDS.worker}'`, { what: 'the chat that queued #7' });
        await page.click('#issues .card[data-key="issue:7"] .tt');
        await page.waitFor(`document.querySelector('#issues .card.open[data-key="issue:7"] .act-btn')`, { what: 'the open card' });
        await page.click('#issues .card.open[data-key="issue:7"] .act-btn');
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')), []);
        assert.ok(await page.ev(`!!${btn}`));
    },

    'a on an issue card asks first, and only the dialog button sends': async ({ page, open }) => {
        await open({ tab: 'issues' });
        await page.waitFor(`document.querySelector('#issues .card[data-key="issue:30"] .act-btn:not([disabled])')`, { what: 'the card' });
        await page.ev(`document.activeElement?.blur(); document.querySelector('#issues .card[data-key="issue:30"]').focus()`);
        await page.key('a');
        await page.waitFor(`document.querySelector('.keys-msg')?.textContent === 'Implement #30'`, { what: 'the confirm dialog' });
        assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')), []);
    }
};
