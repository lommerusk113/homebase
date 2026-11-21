import assert from 'node:assert/strict';

const btn = `document.getElementById('c-model-btn')`;

export default {
    'the model chip shows the chat model, and picking one posts /model <alias> and shows it pending': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`${btn}?.textContent === 'Opus ▾' && !document.getElementById('c-model').hidden`, { what: 'the Opus chip' });
        assert.equal(await page.ev(`getComputedStyle(${btn}).borderTopWidth`), '0px', 'no border');
        assert.ok(await page.ev(`${btn}.getBoundingClientRect().height <= document.getElementById('status').getBoundingClientRect().height`), 'fits the status row');
        const marked = `[...document.querySelectorAll('#c-model wa-dropdown-item')].filter(i => i.checked).map(i => i.value).join()`;
        assert.equal(await page.ev(marked), 'opus', 'the menu marks the chat model');
        await page.click('#c-model-btn');
        await page.clickOn(`document.querySelector('#c-model wa-dropdown-item[value="sonnet"]')`);
        await page.waitFor(`${btn}.textContent === 'Sonnet…' && ${btn}.classList.contains('pending')`, { what: 'the pending chip' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, '/model sonnet']]);
        await page.waitFor(`${marked} === 'sonnet'`, { what: 'the mark on the picked model', timeout: 5000 });
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true });
        await page.waitFor(`${btn}.getBoundingClientRect().width > 0`, { what: 'the chip at phone width' });
        for (let i = 0; i < 10 && !(await page.ev(`document.getElementById('c-model').open`)); i++) { // a click while the pick's close animation runs is dropped
            await page.click('#c-model-btn');
            await new Promise(r => setTimeout(r, 200));
        }
        await page.waitFor(`document.getElementById('c-model').open`, { what: 'the picker open' });
        const fits = `(() => { const r = document.querySelector('#c-model wa-dropdown-item[value="default"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= document.getElementById('status').getBoundingClientRect().top + 4; })()`;
        await page.waitFor(fits, { what: 'the picker on screen, above the chip' });
        await new Promise(r => setTimeout(r, 500)); // the popup's fade-in
        await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); // the harness's size (cdp.mjs)
    },

    'picking a model leaves the typed draft in the box and posts only /model': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`${btn}?.textContent === 'Opus ▾'`, { what: 'the Opus chip' });
        await page.click('#msg');
        await page.type('my unsent draft');
        await page.click('#c-model-btn');
        await page.clickOn(`document.querySelector('#c-model wa-dropdown-item[value="haiku"]')`);
        await page.waitFor(`${btn}.classList.contains('pending')`, { what: 'the pending chip' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, '/model haiku']]);
        assert.equal(await page.ev(`document.getElementById('msg').value`), 'my unsent draft');
    },

    'Claude\'s "Switch model?" confirmation after a pick shows as a card, though the transcript asks nothing': async ({ page, open, answerPosts }) => {
        await open();
        await page.waitFor(`${btn}?.textContent === 'Opus ▾'`, { what: 'the Opus chip' });
        let question = null;
        page.route = q => (q.url.includes('/api/question') && q.method !== 'POST'
            ? { body: JSON.stringify({ question }), headers: { 'content-type': 'application/json' } }
            : (q.url.includes('/api/question') && (question = null), answerPosts(q)));
        await page.click('#c-model-btn');
        await page.clickOn(`document.querySelector('#c-model wa-dropdown-item[value="sonnet"]')`);
        question = { question: 'Switching to Sonnet means the full history gets re-read.', options: ['Yes, switch to Sonnet', 'No, go back'], descriptions: ['', ''], selected: 0 };
        const opts = `[...document.querySelectorAll('#ask-opts wa-button')]`;
        await page.waitFor(`!document.getElementById('ask').hidden && ${opts}.length === 2`, { what: 'the card with the two options, no Chat about this' });
        assert.equal(await page.ev(`document.getElementById('ask-q').textContent`), question.question);
        await page.ev(`${opts}[0].click()`);
        await page.waitFor(`document.getElementById('ask').hidden`, { what: 'the card gone once answered' });
        const u = new URL(page.posts.find(p => p.url.includes('/api/question')).url);
        assert.deepEqual([u.searchParams.get('option'), u.searchParams.get('label')], ['0', 'Yes, switch to Sonnet']);
    },

    'the model chip is disabled while Claude asks, since /model would decline the question': async ({ page, open, IDS }) => {
        await open({ project: 'beta', chat: IDS.asker });
        await page.waitFor(`!document.getElementById('ask').hidden && !document.getElementById('c-model').hidden`, { what: 'the ask card and the chip' });
        assert.equal(await page.ev(`${btn}.disabled`), true);
        await open();
        await page.waitFor(`!document.getElementById('c-model').hidden && document.getElementById('ask').hidden`, { what: 'the chip on a chat that is not asking' });
        assert.equal(await page.ev(`${btn}.disabled`), false);
    }
};
