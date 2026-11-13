import assert from 'node:assert/strict';
import { MR } from './fixture.mjs';

const pane = `document.getElementById('log')`;
const days = `[...${pane}.querySelectorAll('.lg-day > .g-head')].map(h => h.textContent)`;
const agent = `${pane}.querySelector('.lg-agent[data-key="log:agent-notes"]')`;

export default {
    'the Log tab shows a project\'s week by day': async ({ page, open }) => {
        await open({ tab: 'log' });
        await page.waitFor(`${pane}.querySelector('.lg-day')`, { what: 'the day groups' });
        const labels = await page.ev(days);
        assert.match(labels[0], /^(Today|Yesterday) · \d+$/, 'newest day first');
        assert.match(labels.at(-1), /^[A-Z][a-z]+day \d{1,2} [A-Z][a-z]{2} · 1$/, 'older days by weekday and date');
        assert.equal(await page.ev(`${pane}.querySelector('.lg-day:last-child .lg-subj').textContent`), 'Add the audit log');

        // finished subagent: TLDR, its branch's commit nested, the report behind Show more
        assert.equal(await page.ev(`${agent}.querySelector('.lg-head b').textContent`), 'Write release notes');
        assert.equal(await page.ev(`${agent}.querySelector('.lead').textContent`), 'notes ready');
        assert.deepEqual(await page.ev(`[...${agent}.querySelectorAll('.lg-nested .lg-subj')].map(s => s.textContent)`), ['Draft NOTES.md']);
        assert.equal(await page.ev(`${agent}.querySelector('.body').hidden`), true, 'report folded');
        await page.click(`#log .lg-agent[data-key="log:agent-notes"] .lg-head b`);
        await page.waitFor(`!${agent}.querySelector('.body').hidden`, { what: 'the report to unfold' });
        assert.match(await page.ev(`${agent}.querySelector('.body').textContent`), /Notes drafted in NOTES\.md/);
        assert.match(await page.ev(`${pane}.querySelector('.lg-agent[data-key="log:agent-ship"] a.chip').textContent`), /^!102/, 'its MR chip');

        // the agent's commit is not repeated loose; the local-only main commit gets the badge, the pushed one doesn't
        const loose = await page.ev(`[...${pane}.querySelectorAll('.lg-commit .lg-c')].map(c => [c.querySelector('.lg-subj').textContent, c.querySelector('.lg-unpushed')?.textContent ?? null])`);
        assert.deepEqual(loose, [['Add a perks simulator', 'not pushed'], ['Add the audit log', null]]);

        // chat topics, one line per topic change, with their TLDR; merged MRs the chat linked
        const topics = await page.ev(`[...${pane}.querySelectorAll('.lg-tname')].map(t => t.textContent + ' | ' + (t.nextElementSibling?.textContent ?? ''))`);
        assert.deepEqual(topics, ['Release | Should I tag the release now or wait for QA?', 'Fix login | ready']);
        assert.equal(await page.ev(`${pane}.querySelector('.lg-mr a.chip').getAttribute('href')`), MR(100));
    },

    '3 switches to the Log tab': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('3', 'Digit3');
        await page.waitFor(`!${pane}.hidden && document.getElementById('masters').hidden`, { what: 'the Log tab' });
        assert.equal(await page.ev(`document.querySelector('#tabs [data-tab="log"]').getAttribute('aria-selected')`), 'true');
        assert.equal(await page.ev(`localStorage.getItem('tab')`), 'log');
        await page.waitFor(`${pane}.querySelector('.lg-day')`, { what: 'the log to load' });
    },

    'a project with nothing in the last week shows a calm empty state': async ({ page, open }) => {
        await open({ tab: 'log', project: 'beta' });
        await page.waitFor(`${pane}.textContent.startsWith('Nothing')`, { what: 'the empty state' });
        assert.equal(await page.ev(`${pane}.textContent`), 'Nothing happened in beta in the last 7 days.');
    }
};
