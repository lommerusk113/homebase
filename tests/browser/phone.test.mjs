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
    }
};
