import assert from 'node:assert/strict';

import { MR } from './fixture.mjs';

// iPhone-sized viewport with a touch screen for one test, the suite's desktop size and mouse again afterwards (the page is shared)
async function asPhone(page, fn) {
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.cmd('Emulation.setTouchEmulationEnabled', { enabled: true });
    try {
        await fn();
    } finally {
        await page.cmd('Emulation.setTouchEmulationEnabled', { enabled: false });
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    }
}
const shown = id => `(document.getElementById('${id}').offsetParent !== null)`;
const pane = async (page, name) => {
    await page.click(`#ptabs [data-pane="${name}"]`);
    await page.waitFor(`document.querySelector('#ptabs [data-pane="${name}"]').getAttribute('aria-pressed') === 'true'`, { what: `the ${name} tab` });
};

export default {
    'the bottom bar switches between the chat, Work and Issues, and a tap on an asking row opens its chat': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'all' });
            assert.equal(await page.ev(`${shown('feed')} && !${shown('masters')} && !${shown('tabs')}`), true, 'the chat full screen by default, no side-by-side');
            await page.waitFor(`/^\\(\\d+\\) Homebase$/.test(document.title) && ${shown('pt-work-n')}`, { what: 'the Work badge, the count in the title' });
            await pane(page, 'work');
            assert.equal(await page.ev(`${shown('masters')} && !${shown('feed')}`), true, 'the board, not the chat');
            await pane(page, 'issues');
            assert.equal(await page.ev(`${shown('issues')} && !${shown('masters')}`), true);
            assert.equal(await page.ev(`localStorage.getItem('tab')`), 'issues', 'the same remembered view as the header switch');
            // three buttons, each a full tap target; the header's switch is not shown twice, and the board starts right under the header
            assert.deepEqual(await page.ev(`[...document.querySelectorAll('#ptabs button')].map(b => [b.dataset.pane, b.getBoundingClientRect().height >= 44, Math.round(b.getBoundingClientRect().width)])`), [['chat', true, 130], ['work', true, 130], ['issues', true, 130]]);
            assert.equal(await page.ev(`Math.round(document.getElementById('issues').getBoundingClientRect().top - document.querySelector('header.top').getBoundingClientRect().bottom)`), 0);
            await pane(page, 'chat');
            assert.equal(await page.ev(`${shown('feed')} && !${shown('issues')}`), true);
            await pane(page, 'work');
            await page.click(`#masters tr[data-key="asking:${IDS.asker}"]`);
            await page.waitFor(`!document.getElementById('c-back').hidden && ${shown('feed')}`, { what: 'the asking chat, in the chat pane' });
            await page.waitFor(`!document.getElementById('ask').hidden && getComputedStyle(document.querySelector('#ptabs .pt-dot')).display !== 'none'`, { what: 'the ask card and the Chat dot' });
        });
    },

    'stepping in from the Work tab switches to the Chat tab': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'all' });
            await pane(page, 'work');
            await page.clickOn(`document.querySelector('#masters tr[data-key="asking:${IDS.asker}"] wa-button.step-in')`);
            await page.waitFor(`document.querySelector('#ptabs [data-pane="chat"]').getAttribute('aria-pressed') === 'true' && ${shown('feed')}`, { what: 'the Chat tab after stepping in' });
        });
    },

    'focus view at 390px: the back button stays on screen with the Next link showing': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'all', chat: IDS.worker });
            await page.waitFor(`document.querySelector('#feed .bubble')`, { what: 'the chat' });
            await page.ev(`import('/chat.js').then(m => { m.focusChat(${JSON.stringify(IDS.asker)}); })`);
            await page.waitFor(`!document.getElementById('c-back').hidden`, { what: 'focus' });
            await page.ev(`(() => { const n = document.getElementById('c-next'); n.hidden = false; n.textContent = 'Next: Refactor the session store and update docs →'; })()`);
            const r = await page.ev(`(() => { const b = document.getElementById('c-back').getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), w: innerWidth }; })()`);
            assert.ok(r.left >= 0 && r.right <= r.w, `← Main chat spans ${r.left}..${r.right} of ${r.w}`);
        });
    },

    'the composer stays on screen, and typing hides the tab bar': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            const inView = `(() => { const r = document.getElementById('send').getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight; })()`;
            assert.equal(await page.ev(inView), true, 'composer in view');
            await page.ev(`document.getElementById('msg').focus()`);
            await page.waitFor(`!${shown('ptabs')}`, { what: 'the tab bar to give way to the keyboard' });
            assert.equal(await page.ev(inView), true, 'composer in view while typing');
            await page.key('n'); // a shortcut key while typing is just text
            assert.equal(await page.ev(`document.getElementById('msg').value`), 'n');
        });
    },

    'the keyboard: the layout shrinks to the visible height, the header and the composer stay on screen and the feed at its end': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            await page.waitFor(`document.querySelector('#feed .bubble')`, { what: 'the chat' });
            await page.ev(`document.getElementById('msg').focus()`);
            // header, composer and the feed's end inside the top h px
            const fits = h => `(() => { const top = document.querySelector('header.top').getBoundingClientRect(), send = document.getElementById('send').getBoundingClientRect(), f = document.getElementById('feed');
                return top.top >= 0 && top.height > 0 && send.bottom <= ${h} && f.clientHeight > 0 && f.scrollHeight > f.clientHeight && f.scrollHeight - f.scrollTop - f.clientHeight < 2 && scrollY === 0; })()`;
            const vvEvent = `visualViewport.dispatchEvent(new Event('resize')); visualViewport.dispatchEvent(new Event('scroll'));`;
            // iOS: only the visual viewport shrinks (stubbed: headless Chrome has no keyboard), the page is scrolled to the input
            await page.ev(`Object.defineProperty(visualViewport, 'height', { get: () => innerHeight / 2, configurable: true }); scrollTo(0, 50); ${vvEvent}`);
            await page.waitFor(fits('innerHeight / 2'), { what: 'header, composer and the feed\'s end above the keyboard' });
            // keyboard closed: the full height again, no gap left under the composer
            await page.ev(`delete visualViewport.height; ${vvEvent}`);
            await page.waitFor(`document.documentElement.style.getPropertyValue('--vvh') === '' && document.body.getBoundingClientRect().height === innerHeight`, { what: 'the full height back' });
            // a real keyboard takes many frames; here the next resize must not land in the same frame as this one
            await page.ev(`window.__frame = false; requestAnimationFrame(() => requestAnimationFrame(() => { window.__frame = true; }))`);
            await page.waitFor(`window.__frame`, { what: 'a frame' });
            // Android: the keyboard resizes the page itself
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 420, deviceScaleFactor: 1, mobile: true });
            await page.waitFor(fits('innerHeight'), { what: 'header, composer and the feed\'s end in the resized page' });
        });
    },

    'a tap on a row\'s action shows what it will send first, and sends only on Send': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            await pane(page, 'work');
            const btn = `#masters tr[data-key="${MR(104)}"] .act-btn`, sends = () => page.posts.filter(p => p.url.includes('/api/send'));
            const foot = n => `[...document.querySelectorAll('wa-dialog[open] wa-button[slot="footer"]')].at(${n})`;
            // the dialog animates in: a button is tapped once it has stopped moving (two polls at the same place)
            const tap = async (n, what) => {
                await page.waitFor(`(() => { const r = JSON.stringify(${foot(n)}?.getBoundingClientRect()), still = r && r === window.__at; window.__at = r; return still; })()`, { what: `${what} at rest` });
                await page.clickOn(foot(n), what);
            };
            await page.waitFor(`document.querySelector('${btn}')`, { what: 'the action button' });
            await page.click(btn);
            const shown = await page.waitFor(`document.querySelector('wa-dialog[open] pre')?.textContent`, { what: 'the message, shown before it is sent' });
            assert.equal(sends().length, 0, 'nothing sent on the first tap');
            await tap(0, 'Cancel');
            await page.waitFor(`!document.querySelector('wa-dialog[open]')`, { what: 'the dialog to close' });
            assert.equal(sends().length, 0, 'nothing sent on Cancel');
            await page.click(btn);
            await page.waitFor(`document.querySelector('wa-dialog[open] pre')`, { what: 'the dialog again' });
            await tap(-1, 'Send');
            await page.waitFor(`!document.querySelector('${btn}')`, { what: 'the row to turn into a sent one' });
            assert.deepEqual(sends().map(p => p.body), [shown], 'exactly what was shown');
        });
    },

    'a wide table in a reply scrolls sideways inside its bubble, with whole words': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            await page.waitFor(`document.querySelector('#feed .bubble .body')`, { what: 'a reply' });
            const md = '| File | Lines added | Lines removed | Parameter | Description of the change |\n|---|---|---|---|---|\n| src/cart.js | 12 | 4 | discountPercentage | Applies the discount before tax is calculated |';
            await page.ev(`import('/core.js').then(m => { document.querySelector('#feed .bubble .body').append(m.rich(${JSON.stringify(md)})); })`);
            const r = await page.ev(`(() => { const t = document.querySelector('#feed .body table'), b = t.closest('.bubble').getBoundingClientRect();
                return { scrolls: t.scrollWidth > t.clientWidth, inside: t.getBoundingClientRect().right <= b.right, page: document.documentElement.scrollWidth <= innerWidth }; })()`);
            assert.deepEqual(r, { scrolls: true, inside: true, page: true });
        });
    },

    'on a touch screen Enter adds a line and the send button sends; with a mouse there is no send button': async ({ page, open }) => {
        const sendBtn = `(document.getElementById('send-btn')?.offsetParent != null)`;
        await asPhone(page, async () => {
            await open();
            assert.equal(await page.ev(sendBtn), true, 'a send button on touch');
            await page.ev(`document.getElementById('msg').focus()`);
            await page.type('one');
            await page.key('Enter');
            await page.type('two');
            assert.equal(await page.ev(`document.getElementById('msg').value`), 'one\ntwo');
            assert.equal(page.posts.filter(p => p.url.includes('/api/send')).length, 0, 'Enter does not send');
            await page.click('#send-btn');
            await page.waitFor(`document.getElementById('msg').value === ''`, { what: 'the message to go' });
            assert.deepEqual(page.posts.filter(p => p.url.includes('/api/send')).map(p => p.body), ['one\ntwo']);
        });
        await open();
        assert.equal(await page.ev(sendBtn), false, 'no send button with a mouse');
    },

    'the message box shows its placeholder only: its screen-reader name takes no room': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            await page.waitFor(`!!document.getElementById('msg').shadowRoot?.querySelector('[part~="label"]')`, { what: 'the message box' });
            const r = await page.ev(`(() => { const m = document.getElementById('msg'), l = m.shadowRoot.querySelector('[part~="label"]').getBoundingClientRect(); return [Math.round(l.width), Math.round(l.height), Math.round(m.getBoundingClientRect().height)]; })()`);
            assert.deepEqual(r.slice(0, 2), [1, 1]);
            assert.ok(r[2] <= 48, `one line high, got ${r[2]}`);
        });
    }
};
