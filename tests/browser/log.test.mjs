import assert from 'node:assert/strict';
import { MR } from './fixture.mjs';

const pane = `document.getElementById('log')`;
const days = `[...${pane}.querySelectorAll('.lg-day > .g-head')].map(h => h.textContent)`;
const agent = `${pane}.querySelector('.lg-agent[data-key="log:agent-notes"]')`;

const dlg = `document.getElementById('log-dlg')`;
// ☰ → "Activity log…"
async function openLog(page) {
    await page.waitFor(`customElements.get('wa-dialog')`, { what: 'the dialog component' }); // right after a reload it may not be loaded yet
    await page.click('#manage');
    await page.waitFor(`document.querySelector('.d-log-btn')?.checkVisibility()`, { what: 'the ☰ dialog' });
    await page.click('.d-log-btn');
    await page.waitFor(`${dlg}.open && !document.getElementById('dlg').open && ${pane}.checkVisibility()`, { what: 'the activity log dialog' });
}

export default {
    '☰ → Activity log shows a project\'s week by day': async ({ page, open }) => {
        await open();
        assert.equal(await page.ev(`document.querySelector('[data-tab="log"], [data-pane="log"]')`), null, 'no Log tab');
        await openLog(page);
        assert.equal(await page.ev(`${dlg}.getAttribute('label')`), 'Activity log · alpha');
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

        // chat topics are off until the Chat chip is on, and the choice is remembered
        assert.equal(await page.ev(`${pane}.querySelector('.lg-topic').checkVisibility()`), false);
        await page.click('#log .lg-chip:nth-child(3)');
        await page.waitFor(`${pane}.querySelector('.lg-topic').checkVisibility()`, { what: 'chat topics to show' });
        assert.equal(await page.ev(`localStorage.getItem('log:show:chat')`), '1');

        // chat topics, one line per topic change, with their TLDR; merged MRs the chat linked
        const topics = await page.ev(`[...${pane}.querySelectorAll('.lg-tname')].map(t => t.textContent + ' | ' + (t.nextElementSibling?.textContent ?? ''))`);
        assert.deepEqual(topics, ['Release | Should I tag the release now or wait for QA?', 'Fix login | ready']);
        assert.equal(await page.ev(`${pane}.querySelector('.lg-mr a.chip').getAttribute('href')`), MR(100));
    },

    'l opens the activity log over the board, Esc closes it': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('l');
        await page.waitFor(`${dlg}.open && ${pane}.querySelector('.lg-day')`, { what: 'the log to load' });
        assert.equal(await page.ev(`!document.getElementById('masters').hidden && localStorage.getItem('tab')`), 'work', 'the board keeps its view');
        await page.key('Escape', 'Escape');
        await page.waitFor(`!${dlg}.open`, { what: 'the dialog to close' });
    },

    'a project with nothing in the last week shows a calm empty state': async ({ page, open }) => {
        await open({ project: 'beta' });
        await openLog(page);
        await page.waitFor(`${pane}.textContent.startsWith('Nothing')`, { what: 'the empty state' });
        assert.equal(await page.ev(`${pane}.textContent`), 'Nothing happened in beta in the last 7 days.');
    },

    'the Agents chip hides finished subagents, and the choice survives a reload': async ({ page, open }) => {
        await open();
        await openLog(page);
        await page.waitFor(`${agent}`, { what: 'the agent entry' });
        assert.equal(await page.ev(`${agent}.checkVisibility()`), true);
        await page.click('#log .lg-chip:nth-child(1)');
        await page.waitFor(`!${agent}.checkVisibility()`, { what: 'the agent to hide' });
        assert.equal(await page.ev(`${pane}.querySelector('.lg-chip').getAttribute('aria-pressed')`), 'false');
        await page.goto(await page.ev('location.href'));
        await page.waitFor(`document.querySelector('#masters tr[data-key]')`, { what: 'the board after reload' });
        await openLog(page);
        await page.waitFor(`${pane}.querySelector('.lg-day')`, { what: 'the log after reload' });
        assert.equal(await page.ev(`${agent}.checkVisibility()`), false);
    }
};
