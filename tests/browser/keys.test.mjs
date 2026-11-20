import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const focused = `document.activeElement?.dataset?.key ?? null`;
const visibleKeys = `[...document.querySelectorAll('#masters tr[data-key]')].filter(r => r.checkVisibility()).map(r => r.dataset.key)`;

export default {
    '? opens the shortcuts overlay, Esc closes it': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('?', 'Slash');
        await page.waitFor(`document.querySelector('wa-dialog[label="Keyboard shortcuts"]')?.open`, { what: 'the overlay' });
        assert.match(await page.ev(`document.querySelector('wa-dialog[label="Keyboard shortcuts"] .keys-help').textContent`), /j \/ ↓Next item/);
        await page.key('Escape', 'Escape');
        await page.waitFor(`!document.querySelector('wa-dialog[label="Keyboard shortcuts"]')`, { what: 'the overlay to close' });
    },

    'j and k move the row focus': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelectorAll('#masters tr[data-key]').length >= 4`, { what: 'rows' });
        const keys = await page.ev(visibleKeys);
        await page.ev(`document.activeElement?.blur()`);
        await page.key('j');
        assert.equal(await page.ev(focused), keys[0]);
        await page.key('j');
        await page.key('j');
        assert.equal(await page.ev(focused), keys[2]);
        await page.key('k');
        assert.equal(await page.ev(focused), keys[1]);
        assert.equal(await page.ev(`document.activeElement.getAttribute('aria-selected')`), 'true');
    },

    'a chat waiting on you gets a Needs you row, and Enter on it chats with that session': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        const row = `document.querySelector('#masters .g-needs-you tr[data-key="asking:${IDS.master}"]')`;
        await page.waitFor(`${row}?.textContent.includes('Should I tag the release')`, { what: 'the needs-you row' });
        assert.match(await page.ev(`document.title`), /^\(\d+\) Homebase$/);
        await page.ev(`${row}.focus()`);
        await page.key('Enter', 'Enter');
        await page.waitFor(`!document.getElementById('c-back').hidden && !document.getElementById('c-focus').hidden`, { what: 'the chat pane to show the master with a way back' });
        assert.equal(await page.ev(`localStorage.getItem('chat')`), IDS.worker, 'the main chat stays bound');
    },

    'n jumps to the first chat waiting on you, from any tab': async ({ page, open, IDS }) => {
        await open({ tab: 'issues' });
        await page.ev(`document.activeElement?.blur()`);
        await page.waitFor(`document.querySelector('#masters tr[data-key="asking:${IDS.master}"]')`, { what: 'the needs-you row' });
        await page.key('n');
        assert.equal(await page.ev(`localStorage.getItem('tab')`), 'work');
        assert.equal(await page.ev(focused), `asking:${IDS.master}`);
    },

    '[ and ] cycle the tracked projects': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key(']', 'BracketRight');
        await page.waitFor(`localStorage.getItem('project') === 'beta'`, { what: 'beta' });
        await page.key('[', 'BracketLeft');
        await page.key('[', 'BracketLeft');
        await page.waitFor(`localStorage.getItem('project') === 'gamma' && document.getElementById('project').value === 'gamma'`, { what: 'gamma, wrapped around' });
    },

    'the Work | Issues switch: a click, 1/2/t and the arrow keys change the view, and the choice survives a reload': async ({ page, open }) => {
        const view = `(() => { const t = document.getElementById('tabs'); return { sel: [...t.querySelectorAll('[role="tab"]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.tab).join(),
            tabbable: [...t.querySelectorAll('[role="tab"]')].filter(b => b.tabIndex === 0).map(b => b.dataset.tab).join(), work: !document.getElementById('masters').hidden, issues: !document.getElementById('issues').hidden, saved: localStorage.getItem('tab') }; })()`;
        const on = tab => ({ sel: tab, tabbable: tab, work: tab === 'work', issues: tab === 'issues', saved: tab });
        await open();
        assert.equal(await page.ev(`document.getElementById('tabs').getAttribute('role') + ' in ' + document.getElementById('tabs').parentElement.localName + ', ' + document.querySelectorAll('#tabs [role="tab"]').length`), 'tablist in header, 2', 'a two-segment switch in the header, no Log');
        assert.equal(await page.ev(`document.querySelector('.left').firstElementChild.className`), 'stale-note', 'no tab row above the board');
        assert.deepEqual(await page.ev(view), on('work'));
        await page.waitFor(`document.title === '(' + document.querySelector('#tabs .work-n').textContent + ') Homebase'`, { what: 'the waiting count on the Work segment' });
        await page.click('#tabs [data-tab="issues"]');
        assert.deepEqual(await page.ev(view), on('issues'), 'one click');
        // the thumb sits under the selected segment
        await page.waitFor(`(() => { const t = getComputedStyle(document.getElementById('tabs'), '::before'), r = document.getElementById('tabs').getBoundingClientRect(); return new DOMMatrix(t.transform).m41 > r.width / 2 - 6; })()`, { what: 'the thumb under Issues' });
        // focus is on the clicked segment: an arrow key moves to the other one and selects it
        await page.key('ArrowLeft', 'ArrowLeft');
        assert.deepEqual(await page.ev(view), on('work'), 'ArrowLeft');
        assert.equal(await page.ev(`document.activeElement.dataset.tab`), 'work', 'focus follows');
        await page.key('ArrowRight', 'ArrowRight');
        assert.deepEqual(await page.ev(view), on('issues'), 'ArrowRight');
        await page.ev(`document.activeElement?.blur()`);
        await page.key('1', 'Digit1');
        assert.deepEqual(await page.ev(view), on('work'), '1');
        await page.key('2', 'Digit2');
        assert.deepEqual(await page.ev(view), on('issues'), '2');
        await page.key('t');
        assert.deepEqual(await page.ev(view), on('work'), 't swaps');
        await page.key('t');
        assert.deepEqual(await page.ev(view), on('issues'), 't swaps back');
        await page.key('3', 'Digit3');
        assert.deepEqual(await page.ev(view), on('issues'), '3 is no view any more');
        await page.goto(await page.ev('location.href'));
        await page.waitFor(`document.querySelector('#issues .card')`, { what: 'the Issues view after a reload' });
        assert.deepEqual(await page.ev(view), on('issues'), 'remembered');
        // a saved Log tab from before falls back to Work
        await open({ tab: 'log' });
        assert.deepEqual(await page.ev(view), on('work'));
    },

    'r refreshes once, even when pressed twice': async ({ page, open }) => {
        await open();
        await page.ev(`document.activeElement?.blur()`);
        await page.key('r');
        await page.key('r');
        await sleep(1500);
        assert.equal(page.posts.filter(p => p.url.includes('/api/refresh')).length, 1);
        assert.equal(await page.ev(`document.getElementById('reload').classList.contains('spin')`), false, 'spinner stopped');
        assert.match(await page.ev(`document.getElementById('reload-tip').textContent`), /Last refreshed \d+s ago/);
    }
};
