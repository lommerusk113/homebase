import assert from 'node:assert/strict';

const pill = `document.querySelector('#milestone-slot .ms-pick')`;
const btn = `document.getElementById('project')`, isOpen = `!document.querySelector('.pp-pop').hidden`;
const activeRow = `document.querySelector('.pp-row.act')?.dataset.value`;
const visible = `[...document.querySelectorAll('.pp-row:not([hidden])')].map(r => r.dataset.value)`;
const MANY = JSON.stringify(['alpha', 'beta', 'gamma', 'atlas', 'billing-api', 'docs-site', 'infra', 'mobile-app', 'web-shop']);

export default {
    'project picker lists tracked projects with their state and a mouse click switches the board': async ({ page, open, IDS }) => {
        await open({ project: 'all' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('.pp-row .pp-name')].map(o => o.textContent)`), ['All my projects', 'alpha', 'beta', 'gamma']);
        assert.equal(await page.ev(`document.getElementById('milestone-slot').children.length`), 0, 'no pill for All');
        assert.equal(await page.ev(`${btn}.textContent + '|' + ${btn}.value + '|' + ${btn}.getAttribute('aria-expanded') + '|' + ${btn}.getAttribute('aria-haspopup')`), 'All my projects|all|false|listbox');
        await page.click('#project');
        await page.waitFor(`${isOpen} && ${btn}.getAttribute('aria-expanded') === 'true'`, { what: 'the project list to open' });
        assert.equal(await page.ev(`document.querySelector('.pp-list').getAttribute('role') + ' ' + document.querySelector('.pp-row[aria-selected="true"]').dataset.value + ' ' + ${activeRow}`), 'listbox all all', 'a listbox, the current project checked and highlighted');
        await page.waitFor(`document.querySelector('.pp-row[data-value="beta"]').dataset.state === 'needs' && /^1 waiting on you · /.test(document.querySelector('.pp-row[data-value="beta"] small').textContent)`, { what: "beta's asking chat on its row" });
        assert.equal(await page.ev(`getComputedStyle(document.querySelector('.pp-search')).opacity`), '0', 'no filter field for four rows');
        await page.click('.pp-row[data-value="beta"]');
        await page.waitFor(`localStorage.getItem('project') === 'beta' && !${isOpen}`, { what: 'beta to be picked and the list closed' });
        assert.equal(await page.ev(`${btn}.value + ' ' + ${btn}.textContent + ' ' + (document.activeElement === ${btn})`), 'beta beta true');
        await page.waitFor(`[...document.querySelectorAll('#masters tr[data-key]')].map(r => r.dataset.key).join() === 'asking:${IDS.asker},https://github.com/acme/beta/pull/7'`, { what: 'only the beta asking chat and PR on the board' });
        await page.waitFor(`document.getElementById('milestone-slot').hidden`, { what: 'the beta pill hidden' });
    },

    'project picker by keyboard: arrows move, typing filters, Enter picks, Esc closes and returns focus': async ({ page, open }) => {
        await open({ tracked: MANY });
        await page.ev(`${btn}.focus()`);
        await page.key('ArrowDown');
        await page.waitFor(`${isOpen} && document.activeElement === document.querySelector('.pp-search')`, { what: 'the list open with the filter field focused' });
        assert.equal(await page.ev(`getComputedStyle(document.querySelector('.pp-search')).opacity`), '1', 'the filter field shows for a long list');
        assert.equal(await page.ev(activeRow), 'alpha');
        await page.key('ArrowDown');
        assert.equal(await page.ev(`${activeRow} + ' ' + (document.querySelector('.pp-search').getAttribute('aria-activedescendant') === document.querySelector('.pp-row.act').id)`), 'atlas true');
        await page.key('ArrowUp');
        await page.key('ArrowUp');
        assert.equal(await page.ev(activeRow), 'all');
        const rowNode = `document.querySelector('.pp-row[data-value="beta"]')`;
        await page.ev(`window.__row = ${rowNode}`);
        await page.type('b');
        await page.waitFor(`${visible}.join() === 'beta,billing-api,mobile-app,web-shop'`, { what: 'the rows with a b' });
        assert.equal(await page.ev(activeRow), 'beta', 'the first match is highlighted');
        await page.key('ArrowDown');
        await new Promise(r => setTimeout(r, 3500)); // two polls
        assert.equal(await page.ev(`${activeRow} + ' ' + ${visible}.length + ' ' + (window.__row === ${rowNode})`), 'billing-api 4 true', 'polls keep the highlight, the filter and the row nodes');
        await page.type('zz');
        await page.waitFor(`!document.querySelector('.pp-none').hidden && ${visible}.length === 0`, { what: 'Nothing matches' });
        await page.key('Escape');
        await page.waitFor(`!${isOpen} && document.activeElement === ${btn}`, { what: 'closed, focus back on the button' });
        assert.equal(await page.ev(`localStorage.getItem('project')`), 'alpha', 'Esc picks nothing');
        await page.key('Enter');
        await page.waitFor(isOpen, { what: 'Enter to open it' });
        assert.equal(await page.ev(`document.querySelector('.pp-search').value + '|' + ${visible}.length`), '|10', 'opens unfiltered');
        await page.type('gam');
        await page.key('Enter');
        await page.waitFor(`localStorage.getItem('project') === 'gamma' && ${btn}.value === 'gamma' && !${isOpen}`, { what: 'gamma to be picked' });
        await page.key('j');
        assert.equal(await page.ev(isOpen), false, 'the board shortcuts work again');
    },

    'project picker closes on a click outside, and its pinned actions open the dialogs': async ({ page, open }) => {
        await open();
        await page.click('#project');
        await page.waitFor(isOpen, { what: 'open' });
        await page.click('.brand');
        await page.waitFor(`!${isOpen}`, { what: 'closed by the outside click' });
        await page.click('#project');
        await page.clickOn(`[...document.querySelectorAll('.pp-foot button')].find(b => b.textContent === 'Manage projects…')`);
        await page.waitFor(`document.getElementById('dlg').open && !${isOpen}`, { what: 'the projects dialog' });
    },

    'the picker button signals chats waiting in other projects, and the Work count is only the board\'s own Needs you rows': async ({ page, open, IDS }) => {
        const titleCount = `Number(document.title.match(/^\\((\\d+)\\)/)?.[1] ?? 0)`;
        const workN = `(() => { const n = document.querySelector('#tabs .work-n'); return n.hidden ? 0 : Number(n.textContent); })()`;
        const needsRows = `document.querySelectorAll('#masters .g-needs-you tr[data-key]').length`;
        await open({ tracked: '["gamma","beta"]', project: 'gamma' });
        await page.waitFor(`${btn}.dataset.other && ${titleCount} > 0`, { what: 'the cue on the picker button and the global title count' });
        const other = await page.ev(`Number(${btn}.dataset.other)`);
        assert.ok(other >= 1);
        assert.equal(await page.ev(`${btn}.getAttribute('aria-label')`), `Project: gamma, ${other} waiting on you in other projects`);
        assert.equal(await page.ev(`getComputedStyle(${btn}, '::after').content`), `"${other}"`, 'a bare numeral on the button');
        assert.equal(await page.ev(`!!document.getElementById('proj-chips')`), false, 'no project pills');
        assert.equal(await page.ev(needsRows), 0, 'a quiet project: no Needs you rows');
        await page.click('#tabs [data-tab="issues"]');
        assert.equal(await page.ev(workN), 0, 'no count on Work for the other project\'s items');
        await page.click('#project');
        await page.click('.pp-row[data-value="beta"]');
        await page.waitFor(`document.querySelector('#masters tr[data-key="asking:${IDS.asker}"]')`, { what: "beta's board" });
        const rows = await page.ev(needsRows);
        assert.ok(rows >= 1);
        assert.equal(await page.ev(workN), rows, 'the count equals the Needs you rows on the board');
        assert.ok(!(await page.ev(`${btn}.dataset.other`)), 'nothing waits in the other project now');
        await page.click('#tabs [data-tab="work"]');
        assert.equal(await page.ev(`getComputedStyle(document.querySelector('#tabs .work-n')).display`), 'none', 'on Work the group heading says it');
    },

    'milestone pill is hidden for a project without milestones and shown for one with': async ({ page, open }) => {
        await open({ project: 'beta', chat: null });
        await page.waitFor(`${pill}?.classList.contains('off') && document.getElementById('milestone-slot').hidden`, { what: 'the pill hidden' });
        assert.equal(await page.ev(`document.getElementById('milestone-slot').getBoundingClientRect().width`), 0, 'no gap');
        await page.click('#project');
        await page.click('.pp-row[data-value="alpha"]');
        await page.waitFor(`!document.getElementById('milestone-slot').hidden && ${pill}?.querySelector('summary .t')?.textContent === 'Sprint 12'`, { what: 'the pill shown' });
    }
};
