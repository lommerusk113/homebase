import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
    },

    'Send findings types the reviewer\'s final message into the working chat, once': async ({ page, open, homebase, restartServer }) => {
        // a finished reviewer chat in alpha, mapped to the first in-review row; nothing is started or typed anywhere (POSTs are intercepted)
        const id = 'bbbbbbbb-0000-4000-8000-0000000000ff';
        const home = join(homebase, '..', 'home'), dir = join(home, '.claude', 'projects', '-fx-alpha'), file = join(dir, `${id}.jsonl`);
        const at = s => new Date(Date.now() - s * 1000).toISOString();
        const e = x => JSON.stringify({ isSidechain: false, cwd: join(home, 'repos', 'alpha'), sessionId: id, gitBranch: 'main', ...x });
        const FINDINGS = '| 1 | nit in login.js |\n\n**Verdict: fix first**';
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, [
            e({ type: 'user', uuid: 'u1', timestamp: at(60), origin: { kind: 'human' }, turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: 'Run review-gate' } }),
            e({ type: 'assistant', uuid: 'a1', timestamp: at(30), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: FINDINGS }] } }),
            e({ type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: at(29) })
        ].join('\n') + '\n');
        try {
            await open();
            const key = await page.ev(`import('/core.js').then(core => ${items}.find(i => i.column === 'review' && i.action?.kind === 'review')?.key)`);
            assert.ok(key, 'an in-review row with a Review button');
            writeFileSync(join(homebase, 'reviewers.json'), JSON.stringify([[key, { id, at: Date.now() - 20_000, sent: false }]]));
            await restartServer();
            await open();
            await page.waitFor(`${row(key)}?.querySelector('.act-btn')?.textContent.trim() === 'Send findings'`, { what: 'Send findings' });
            assert.equal(await page.ev(`import('/core.js').then(core => ${items}.filter(i => i.sessionId === ${JSON.stringify(id)}).length)`), 0, 'the reviewer chat is not a row');
            page.posts.length = 0;
            await page.ev(`${row(key)}.querySelector('.act-btn').click()`);
            const want = `Review findings from a fresh reviewer:\n\n${FINDINGS}\n\nAddress them.`;
            await page.waitFor(`import('/core.js').then(core => core.state.outbox.some(o => o.text === ${JSON.stringify(want)}))`, { what: 'the findings in the outbox' });
            const sends = page.posts.filter(p => p.url.includes('/api/send'));
            assert.deepEqual(sends.map(p => p.body), [want]);
            assert.ok(sends[0].url.includes(`id=${await page.ev(`import('/core.js').then(core => ${items}.find(i => i.key === ${JSON.stringify(key)}).sessionId)`)}`), 'into the row\'s working chat, not the reviewer');
            assert.ok(page.posts.some(p => p.url.includes('/api/reviewer/sent')), 'marks the findings sent');
        } finally {
            rmSync(file, { force: true });
            rmSync(join(homebase, 'reviewers.json'), { force: true });
            await restartServer();
        }
    }
};
