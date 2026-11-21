import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

const focused = `(document.activeElement?.dataset?.key ?? null)`;
const visibleKeys = `[...document.querySelectorAll('#masters tr[data-key]')].filter(r => r.checkVisibility()).map(r => r.dataset.key)`;

export default {
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

    'a digit answers the numbered option of the question open in the chat, and is typed in the composer': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`document.querySelectorAll('#feed .replies wa-button').length === 3`, { what: 'the numbered options' });
        await page.ev(`document.activeElement?.blur()`);
        await page.key('3', 'Digit3');
        await page.waitFor(`[...document.querySelectorAll('#feed .answer')].some(a => a.textContent.includes('You: No'))`, { what: 'the answer tag' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'No']]);
        assert.equal(await page.ev(`localStorage.getItem('tab')`), 'work', 'the view did not change');
        await page.click('#msg');
        await page.key('2', 'Digit2');
        assert.equal(await page.ev(`document.getElementById('msg').value`), '2');
        assert.equal(page.posts.length, 1, 'typed, not sent');
    },

    'Enter on a waiting row puts focus on the first option of its question, and answering there moves it to the composer': async ({ page, open, IDS }) => {
        await open({ chat: IDS.worker });
        const row = `document.querySelector('#masters tr[data-key="asking:${IDS.master}"]')`;
        await page.waitFor(row, { what: 'the needs-you row' });
        await page.ev(`${row}.focus()`);
        await page.key('Enter', 'Enter');
        await page.waitFor(`document.activeElement?.matches('wa-button.c-opt')`, { what: 'focus on an option' });
        assert.equal(await page.ev(`document.activeElement.querySelector('.k').textContent`), '1', 'the first one');
        const label = await page.ev(`document.activeElement.firstChild.textContent`);
        await page.key('Enter', 'Enter');
        await page.waitFor(`document.activeElement?.id === 'msg'`, { what: 'focus on the composer' });
        assert.deepEqual(page.posts.map(p => p.body), [label]);
    },

    'n steps through every chat waiting on you and starts over': async ({ page, open, IDS }) => {
        await open({ project: 'all', chat: IDS.worker });
        await page.waitFor(`document.querySelectorAll('#masters tr[data-key^="asking:"]').length >= 2`, { what: 'two waiting chats' });
        const waiting = await page.ev(`[...document.querySelectorAll('#masters tr[data-key^="asking:"]')].map(r => r.dataset.key)`);
        await page.ev(`document.activeElement?.blur()`);
        const seen = [];
        for (let i = 0; i <= waiting.length; i++) {
            await page.key('n');
            seen.push(await page.ev(focused));
        }
        assert.deepEqual(seen, [...waiting, waiting[0]]);
    },

    'closing help, the changes panel or a row action puts focus back on the row, also when the board was redrawn meanwhile': async ({ page, open }) => {
        await open();
        const redraw = `import('/list.js').then(m => (m.renderBoard(), true))`;
        const key = await page.waitFor(`document.querySelector('#masters tr[data-key] .act-btn')?.closest('tr').dataset.key`, { what: 'a row with an action' });
        await page.ev(`document.querySelector('#masters tr[data-key="${key}"]').focus()`);
        await page.key('?', 'Slash');
        await page.waitFor(`document.querySelector('wa-dialog .keys-help')?.checkVisibility()`, { what: 'the help' });
        await page.ev(redraw);
        await page.key('Escape');
        await page.waitFor(`${focused} === ${JSON.stringify(key)}`, { what: 'focus back on the row after help' });
        await page.key('d');
        await page.waitFor(`document.querySelector('.dv')`, { what: 'the changes panel' });
        await page.ev(redraw);
        await page.key('Escape');
        await page.waitFor(`!document.querySelector('.dv') && ${focused} === ${JSON.stringify(key)}`, { what: 'focus back on the row after the changes panel' });
        await page.key('a');
        await page.waitFor(`document.querySelector('wa-dialog .keys-msg')?.checkVisibility()`, { what: 'the confirm dialog' });
        await page.clickOn(`document.querySelector('wa-dialog:has(.keys-msg) wa-button[variant="brand"]')`);
        await page.waitFor(`!document.querySelector('wa-dialog .keys-msg') && ${focused} === ${JSON.stringify(key)}`, { what: 'focus back on the row after its action' });
    },

    '] and [ go round the projects with All my projects as one stop': async ({ page, open }) => {
        await open({ project: 'gamma' });
        await page.ev(`document.activeElement?.blur()`);
        const project = `localStorage.getItem('project')`;
        await page.key(']', 'BracketRight');
        await page.waitFor(`${project} === 'all'`, { what: 'All after the last project', timeout: 3000 });
        await page.key(']', 'BracketRight');
        await page.waitFor(`${project} === 'alpha'`, { what: 'the first project after All', timeout: 3000 });
        await page.key('[', 'BracketLeft');
        await page.waitFor(`${project} === 'all'`, { what: 'All before the first project', timeout: 3000 });
    },

    'the bell says so when the browser blocks notifications': async ({ page, open, base }) => {
        await page.cmd('Browser.setPermission', { permission: { name: 'notifications' }, setting: 'denied', origin: base });
        try {
            await open();
            await page.click('#bell');
            await page.waitFor(`document.querySelector('wa-tooltip[for="' + document.getElementById('bell').id + '"]')?.open`, { what: 'the note beside the bell', timeout: 3000 });
            assert.equal(await page.ev(`document.getElementById('bell').getAttribute('aria-pressed')`), 'false');
        } finally {
            await page.cmd('Browser.resetPermissions');
        }
    },

    'the Work | Issues switch: a click, 1/2/t and the arrow keys change the view, and the choice survives a reload': async ({ page, open, IDS }) => {
        const view = `(() => { const t = document.getElementById('tabs'); return { sel: [...t.querySelectorAll('[role="tab"]')].filter(b => b.getAttribute('aria-selected') === 'true').map(b => b.dataset.tab).join(),
            tabbable: [...t.querySelectorAll('[role="tab"]')].filter(b => b.tabIndex === 0).map(b => b.dataset.tab).join(), work: !document.getElementById('masters').hidden, issues: !document.getElementById('issues').hidden, saved: localStorage.getItem('tab') }; })()`;
        const on = tab => ({ sel: tab, tabbable: tab, work: tab === 'work', issues: tab === 'issues', saved: tab });
        await open({ chat: IDS.worker }); // a chat with no question open: the digits are the views'
        assert.equal(await page.ev(`document.getElementById('tabs').getAttribute('role') + ' in ' + document.getElementById('tabs').parentElement.localName + ', ' + document.querySelectorAll('#tabs [role="tab"]').length`), 'tablist in div, 2', 'the board title row, two words, no Log');
        assert.equal(await page.ev(`document.querySelector('.left').firstElementChild.id + ' ' + !!document.querySelector('header.top #tabs')`), 'tabs false', 'the switch is the board pane\'s first child, not in the header');
        assert.equal(await page.ev(`document.getElementById('tab-open')`), null, 'no count on Issues');
        assert.equal(await page.ev(`getComputedStyle(document.querySelector('#tabs .work-n')).display`), 'none', 'no Work count while Work is selected');
        assert.deepEqual(await page.ev(view), on('work'));
        await page.click('#tabs [data-tab="issues"]');
        assert.deepEqual(await page.ev(view), on('issues'), 'one click');
        await page.waitFor(`getComputedStyle(document.querySelector('#tabs .work-n')).display !== 'none' && Number(document.querySelector('#tabs .work-n').textContent) > 0`, { what: 'the needs-you count beside Work, shown on Issues' });
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
    }
};
