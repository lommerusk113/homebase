import assert from 'node:assert/strict';

// iPhone-sized viewport for one test, the suite's desktop size again afterwards (the page is shared)
async function asPhone(page, fn) {
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    try {
        await fn();
    } finally {
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

    'the project picker is a bottom sheet with 44px rows; a tap picks, a tap on the backdrop closes': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            await page.click('#project');
            await page.waitFor(`!document.querySelector('.pp-pop').hidden`, { what: 'the sheet' });
            const slidIn = () => page.waitFor(`Math.round(document.querySelector('.pp-panel').getBoundingClientRect().bottom) === innerHeight`, { what: 'the sheet slid in' });
            await slidIn();
            const r = await page.ev(`(() => { const p = document.querySelector('.pp-panel').getBoundingClientRect(); return { left: p.left, w: p.width, bottom: Math.round(p.bottom), vw: innerWidth, vh: innerHeight,
                small: [...document.querySelectorAll('.pp-row, .pp-foot button')].filter(e => e.getBoundingClientRect().height < 44).length, focus: document.activeElement.className }; })()`);
            assert.deepEqual(r, { left: 0, w: 390, bottom: 844, vw: 390, vh: 844, small: 0, focus: 'pp-list' }, 'full width at the bottom edge, no keyboard-raising focus');
            await page.cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: 195, y: 100, button: 'left', clickCount: 1 });
            await page.cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 195, y: 100, button: 'left', clickCount: 1 });
            await page.waitFor(`document.querySelector('.pp-pop').hidden`, { what: 'closed by the backdrop' });
            assert.equal(await page.ev(`localStorage.getItem('project')`), 'alpha');
            await page.click('#project');
            await page.waitFor(`!document.querySelector('.pp-pop').hidden`, { what: 'the sheet again' });
            await slidIn();
            await page.click('.pp-row[data-value="gamma"]');
            await page.waitFor(`localStorage.getItem('project') === 'gamma' && document.querySelector('.pp-pop').hidden`, { what: 'gamma picked' });
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

    'nothing scrolls sideways at 390px': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'beta', chat: IDS.asker });
            await page.waitFor(`!document.getElementById('ask').hidden`, { what: 'the ask card' });
            const wide = `[document.documentElement, document.body, ...document.querySelectorAll('header.top, .main, #chat, #feed, .c-cards, #send, #masters, #issues, #ptabs')]
                .filter(e => e.offsetParent !== null || e === document.body || e === document.documentElement)
                .filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > innerWidth + 1).map(e => e.id || e.className || e.tagName)`;
            assert.deepEqual(await page.ev(wide), [], 'chat');
            const small = `[...document.querySelectorAll('#ask-opts wa-button, #ask .c-term wa-button:not([hidden])')].filter(e => e.offsetParent !== null && e.getBoundingClientRect().height < 44).map(e => e.id || e.textContent)`;
            await page.waitFor(`${small}.length === 0`, { what: 'tap targets of at least 44px (once the buttons render)' });
            await open({ project: 'alpha' });
            for (const name of ['work', 'issues']) {
                await pane(page, name);
                await page.waitFor(`document.querySelector('#${name === 'work' ? 'masters' : name}').children.length`, { what: name });
                assert.deepEqual(await page.ev(wide), [], name);
            }
        });
    },

    'the composer stays on screen at 16px, and typing hides the tab bar': async ({ page, open }) => {
        await asPhone(page, async () => {
            await open();
            const inView = `(() => { const r = document.getElementById('send').getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight; })()`;
            assert.equal(await page.ev(inView), true, 'composer in view');
            assert.equal(await page.ev(`getComputedStyle(document.getElementById('msg')).fontSize`), '16px', 'no iOS zoom on focus');
            await page.ev(`document.getElementById('msg').focus()`);
            await page.waitFor(`!${shown('ptabs')}`, { what: 'the tab bar to give way to the keyboard' });
            assert.equal(await page.ev(inView), true, 'composer in view while typing');
            await page.key('n'); // a shortcut key while typing is just text
            assert.equal(await page.ev(`document.getElementById('msg').value`), 'n');
        });
    }
};
