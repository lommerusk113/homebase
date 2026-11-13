import assert from 'node:assert/strict';

const pill = `document.querySelector('#milestone-slot .ms-pick')`;

export default {
    'project dropdown lists tracked projects and switches the board': async ({ page, open }) => {
        await open({ project: 'all' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#project wa-option')].map(o => o.textContent)`), ['All my projects', 'alpha', 'beta', 'gamma']);
        assert.equal(await page.ev(`document.getElementById('milestone-slot').children.length`), 0, 'no pill for All');
        await page.click('#project');
        await page.waitFor(`document.getElementById('project').open`, { what: 'the project list to open' });
        await page.click('#project wa-option[value="beta"]');
        await page.waitFor(`localStorage.getItem('project') === 'beta'`, { what: 'beta to be picked' });
        await page.waitFor(`[...document.querySelectorAll('#masters tr[data-key]')].map(r => r.dataset.key).join() === 'https://github.com/acme/beta/pull/7'`, { what: 'only the beta PR on the board' });
        await page.waitFor(`${pill}?.textContent.includes('No milestones')`, { what: 'the beta pill' });
    },

    'milestone pill shows the active milestone and its counts': async ({ page, open }) => {
        await open();
        await page.waitFor(`${pill}?.querySelector('summary .n')?.textContent === '· 4 open'`, { what: '"4 open"' });
        assert.equal(await page.ev(`${pill}.querySelector('summary .t').textContent`), 'Sprint 12');
        assert.match(await page.ev(`${pill}.querySelector('summary').title`), /^Sprint 12: 4 open of 5 \(1 in progress, 1 can be closed, 1 not started, 1 unassigned\), 1 closed/);
        await page.click('#milestone-slot .ms-pick summary');
        await page.waitFor(`${pill}.open && ${pill}.querySelector('.ms-menu h5.hot')?.textContent === 'Can be closed (1)'`, { what: 'the menu' });
    },

    'milestone pill says "No milestones" for a project without any': async ({ page, open }) => {
        await open({ project: 'beta', chat: null });
        await page.waitFor(`${pill}?.classList.contains('off') && ${pill}.querySelector('summary').textContent === '⚑No milestones'`, { what: 'No milestones' });
        assert.equal(await page.ev(`${pill}.classList.contains('err')`), false);
    },

    'milestone pill shows the error state when glab fails': async ({ page, open }) => {
        await open({ project: 'gamma', chat: null });
        await page.waitFor(`${pill}?.classList.contains('err') && ${pill}.querySelector('summary').textContent === '⚑Milestones unavailable'`, { what: 'Milestones unavailable' });
        assert.match(await page.ev(`${pill}.querySelector('summary').title`), /401 Unauthorized/);
    }
};
