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
    'the bottom tab bar switches between the chat and the board tabs, and a tap on an asking row opens its chat': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'all' });
            assert.equal(await page.ev(`${shown('feed')} && !${shown('masters')} && !${shown('tabs')}`), true, 'the chat full screen by default, no side-by-side');
            await page.waitFor(`document.title === '(' + document.getElementById('pt-work-n').textContent + ') Homebase' && ${shown('pt-work-n')}`, { what: 'the Work badge, the count in the title' });
            await pane(page, 'work');
            assert.equal(await page.ev(`${shown('masters')} && !${shown('feed')}`), true, 'the board, not the chat');
            await pane(page, 'issues');
            assert.equal(await page.ev(`${shown('issues')} && !${shown('masters')}`), true);
            await pane(page, 'log');
            assert.equal(await page.ev(`${shown('log')} && !${shown('issues')}`), true);
            await pane(page, 'chat');
            assert.equal(await page.ev(`${shown('feed')} && !${shown('log')}`), true);
            await pane(page, 'work');
            await page.click(`#masters tr[data-key="asking:${IDS.asker}"]`);
            await page.waitFor(`!document.getElementById('c-back').hidden && ${shown('feed')}`, { what: 'the asking chat, in the chat pane' });
            await page.waitFor(`!document.getElementById('ask').hidden && getComputedStyle(document.querySelector('#ptabs .pt-dot')).display !== 'none'`, { what: 'the ask card and the Chat dot' });
        });
    },

    'nothing scrolls sideways at 390px except the header strip': async ({ page, open, IDS }) => {
        await asPhone(page, async () => {
            await open({ project: 'beta', chat: IDS.asker });
            await page.waitFor(`!document.getElementById('ask').hidden`, { what: 'the ask card' });
            const wide = `[document.documentElement, document.body, ...document.querySelectorAll('.main, #chat, #feed, .c-cards, #send, #masters, #issues, #log, #ptabs')]
                .filter(e => e.offsetParent !== null || e === document.body || e === document.documentElement)
                .filter(e => e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > innerWidth + 1).map(e => e.id || e.className || e.tagName)`;
            assert.deepEqual(await page.ev(wide), [], 'chat');
            const small = `[...document.querySelectorAll('#ask-opts wa-button, #ask .c-term wa-button:not([hidden]), #send-btn')].filter(e => e.offsetParent !== null && e.getBoundingClientRect().height < 44).map(e => e.id || e.textContent)`;
            await page.waitFor(`${small}.length === 0`, { what: 'tap targets of at least 44px (once the buttons render)' });
            await open({ project: 'alpha' });
            for (const name of ['work', 'issues', 'log']) {
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
            assert.equal(await page.ev(`document.getElementById('send-btn').getBoundingClientRect().height >= 44`), true);
            await page.ev(`document.getElementById('msg').focus()`);
            await page.waitFor(`!${shown('ptabs')}`, { what: 'the tab bar to give way to the keyboard' });
            assert.equal(await page.ev(inView), true, 'composer in view while typing');
            await page.key('n'); // a shortcut key while typing is just text
            assert.equal(await page.ev(`document.getElementById('msg').value`), 'n');
        });
    }
};
