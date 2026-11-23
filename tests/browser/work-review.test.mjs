import assert from 'node:assert/strict';
import { MR } from './fixture.mjs';

const row = key => `document.querySelector('#masters tr[data-key="${key}"]')`;
const phone = (page, on) => page.cmd('Emulation.setDeviceMetricsOverride', on ? { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } : { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
const items = `core.state.sessions.flatMap(s => s.items || [])`;

export default {
    'Review requested rows open the MR on o and Space like other rows': async ({ page, open }) => {
        await open();
        const k = `review:${MR(201)}`;
        await page.waitFor(row(k));
        await page.ev(`window.__opened = []; window.open = u => { window.__opened.push(u); }; ${row(k)}.focus()`);
        await page.key('o');
        assert.deepEqual(await page.ev('window.__opened'), [MR(201)]);
        await page.key(' ', 'Space');
        assert.deepEqual(await page.ev('window.__opened'), [MR(201), MR(201)]);
    },

    'phone: the expanded detail has the MR chip and CI pill': async ({ page, open }) => {
        await phone(page, true);
        try {
            await open();
            await page.click('#ptabs [data-pane="work"]');
            await page.waitFor(row(MR(101)));
            await page.click(`#masters tr[data-key="${MR(101)}"] .what b`);
            await page.click('#ptabs [data-pane="work"]');
            await page.waitFor(`document.querySelector('#masters tr.detail')`);
            assert.equal(await page.ev(`[...document.querySelectorAll('#masters tr.detail .d-mr :is(a.chip, .ci-pill)')].filter(e => e.checkVisibility()).length >= 2`), true);
            assert.equal(await page.ev(`document.documentElement.scrollWidth <= innerWidth`), true, 'no side scroll');
        } finally {
            await page.click('#ptabs [data-pane="chat"]').catch(() => {});
            await phone(page, false);
        }
    },

    'only folded groups: no "nothing right now" line': async ({ page, open }) => {
        await open();
        await page.waitFor(row(MR(103)));
        const out = await page.ev(`(async () => {
            const core = await import('/core.js'), list = await import('/list.js');
            const many = n => ({ key: 'x' + n, project: 'alpha', title: 'MR ' + n, column: 'review', stage: 2, stageLabel: 'Review', next: 'Waiting for review by Ann', updated: Date.now(), milestone: { id: 11, title: 'Sprint 12' }, pr: 'https://gitlab.com/acme/alpha/-/merge_requests/' + (300 + n) });
            for (const s of core.state.sessions) { s.items = []; s.asking = false; s.needsYou = false; s.status = 'idle'; s.queued = []; }
            core.state.sessions.find(s => s.project === 'alpha').items = [1, 2, 3, 4, 5].map(many);
            core.state.reviews = [];
            list.renderBoard();
            await new Promise(r => setTimeout(r)); // the island draws a tick later
            return [document.querySelector('#masters .d-empty, #masters .welcome')?.textContent ?? null, document.querySelectorAll('#masters .g-head').length];
        })()`);
        assert.deepEqual(out, [null, 1]);
    },

    'an MR without a milestone is hidden under a picked milestone': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(104))}`);
        const out = await page.ev(`(async () => {
            const core = await import('/core.js'), list = await import('/list.js');
            const it = ${items}.find(i => i.pr && i.prState && i.milestone);
            const shown = () => !!document.querySelector('#masters tr[data-key="' + it.key + '"]');
            const before = shown();
            it.milestone = null;
            list.renderBoard();
            await new Promise(r => setTimeout(r)); // the island draws a tick later
            return [before, shown()];
        })()`);
        assert.deepEqual(out, [true, false]);
    },

    'a needs-you MR without a milestone is hidden under a picked milestone too': async ({ page, open }) => {
        await open();
        await page.waitFor(`${row(MR(104))}`);
        const out = await page.ev(`(async () => {
            const core = await import('/core.js'), list = await import('/list.js');
            ${items}.find(i => i.key === ${JSON.stringify(MR(104))}).milestone = null;
            list.renderBoard();
            await new Promise(r => setTimeout(r)); // the island draws a tick later
            return !!document.querySelector('#masters tr[data-key="${MR(104)}"]');
        })()`);
        assert.equal(out, false);
    },

    'the no-response hint goes once the MR has another action': async ({ page, open }) => {
        await open();
        await page.waitFor(row(MR(104)));
        await page.ev(`sessionStorage.setItem('sent', JSON.stringify([[${JSON.stringify(MR(104))}, Date.now() - 200000]]))`);
        await page.goto(await page.ev('location.href'));
        await page.waitFor(`${row(MR(104))}?.querySelector('.no-reply')`, { what: 'the no-reply hint' });
        const out = await page.ev(`(async () => {
            const core = await import('/core.js'), list = await import('/list.js');
            const x = ${items}.find(i => i.key === ${JSON.stringify(MR(104))});
            Object.assign(x, { column: 'ready', next: 'Approved — merge it', action: { label: 'Merge + close issue', message: 'merge' } });
            list.renderBoard();
            await new Promise(r => setTimeout(r)); // the island draws a tick later
            return !!document.querySelector('#masters tr[data-key="${MR(104)}"] .no-reply');
        })()`);
        assert.equal(out, false);
    }
};
