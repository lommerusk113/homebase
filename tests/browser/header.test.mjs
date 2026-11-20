import assert from 'node:assert/strict';

const pill = `document.querySelector('#milestone-slot .ms-pick')`;

export default {
    'project dropdown lists tracked projects and switches the board': async ({ page, open, IDS }) => {
        await open({ project: 'all' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#project wa-option')].map(o => o.textContent)`), ['All my projects', 'alpha', 'beta', 'gamma']);
        assert.equal(await page.ev(`document.getElementById('milestone-slot').children.length`), 0, 'no pill for All');
        await page.click('#project');
        await page.waitFor(`document.getElementById('project').open`, { what: 'the project list to open' });
        await page.click('#project wa-option[value="beta"]');
        await page.waitFor(`localStorage.getItem('project') === 'beta'`, { what: 'beta to be picked' });
        await page.waitFor(`[...document.querySelectorAll('#masters tr[data-key]')].map(r => r.dataset.key).join() === 'asking:${IDS.asker},https://github.com/acme/beta/pull/7'`, { what: 'only the beta asking chat and PR on the board' });
        await page.waitFor(`${pill}?.textContent.includes('No milestones')`, { what: 'the beta pill' });
    },

    'project chips show only projects that need you, as a warn count, and a click switches to it': async ({ page, open, IDS }) => {
        const chip = name => `[...document.querySelectorAll('#proj-chips .proj-chip')].find(b => b.firstChild.textContent === '${name}')`;
        const titleCount = `Number(document.title.match(/^\\((\\d+)\\)/)?.[1] ?? 0)`;
        await open({ tracked: '["alpha"]' });
        await page.waitFor(`${titleCount} > 0`, { what: 'a count in the title' });
        const alphaOnly = await page.ev(titleCount);
        await open();
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#proj-chips .proj-chip')].map(b => b.firstChild.textContent)`), ['alpha', 'beta'], 'gamma needs nothing: no chip');
        assert.equal(await page.ev(`${chip('alpha')}.querySelectorAll('small').length`), 1, 'only the warn count, no open number');
        assert.equal(await page.ev(`${chip('alpha')}.getAttribute('aria-pressed')`), 'true');
        await page.waitFor(`${chip('beta')}?.querySelector('.warn')?.textContent === '⚠1'`, { what: "beta's asking chat on its chip" });
        assert.ok(await page.ev(titleCount) > alphaOnly, 'the title counts beta, though alpha is selected');
        assert.ok(!(await page.ev(`document.querySelector('#masters tr[data-key="asking:${IDS.asker}"]')`)), "beta's row stays off alpha's board");
        await page.click('#proj-chips .proj-chip:nth-child(2)');
        await page.waitFor(`localStorage.getItem('project') === 'beta' && document.getElementById('project').value === 'beta'`, { what: 'beta to be picked' });
        await page.waitFor(`document.querySelector('#masters tr[data-key="asking:${IDS.asker}"]')`, { what: "beta's board" });
    },

    'project chips container is gone when no project needs you': async ({ page, open }) => {
        await open({ tracked: '["gamma"]' });
        await page.waitFor(`document.getElementById('project')`, { what: 'the header' });
        assert.equal(await page.ev(`getComputedStyle(document.getElementById('proj-chips')).display`), 'none');
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
