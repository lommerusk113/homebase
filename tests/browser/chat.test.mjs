import assert from 'node:assert/strict';

const bubble = text => `[...document.querySelectorAll('#feed .bubble')].find(b => b.textContent.includes(${JSON.stringify(text)}))`;
const ready = page => page.waitFor(`${bubble('tag the release')}`, { what: 'the newest master bubble' });

export default {
    'Clear view hides what came before the cut, and Show brings it back': async ({ page, open, IDS }) => {
        await open({ [`cleared:${IDS.master}`]: String(Date.now() - 150_000) });
        await ready(page);
        assert.equal(await page.ev(`!!${bubble('Fix the login redirect bug')}`), false);
        assert.equal(await page.ev(`document.querySelector('#feed').firstElementChild.className`), 'c-hidden');
        await page.click('#feed .c-hidden button');
        await page.waitFor(`${bubble('Fix the login redirect bug')}`, { what: 'the hidden history to come back' });
    },

    'a New conversation cut hides the history without the Show line': async ({ page, open, IDS }) => {
        await open({ [`cleared:${IDS.master}`]: JSON.stringify({ at: Date.now() - 150_000, mode: 'new' }) });
        await ready(page);
        assert.equal(await page.ev(`!!${bubble('Fix the login redirect bug')}`), false);
        assert.equal(await page.ev(`!!document.querySelector('#feed .c-hidden')`), false);
    },

    'history renders, including what came before a huge tool result': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.ok(await page.ev(`!!${bubble('Fix the login redirect bug')}?.classList.contains('user')`), 'first prompt, before the 2 MB line');
        assert.ok(await page.ev(`[...document.querySelectorAll('#feed .tools')].some(t => t.textContent === 'Ran 1 command')`), 'tool summary line');
        assert.equal(await page.ev(`document.getElementById('feed').scrollHeight - document.getElementById('feed').scrollTop - document.getElementById('feed').clientHeight < 40`), true, 'scrolled to the bottom');
    },

    'topic header and needs-you styling': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .b-topic-name')].map(t => t.textContent)`), ['Fix login', 'Release'], 'a header only where the topic changes');
        assert.ok(await page.ev(`${bubble('cookie scope')}.matches('.bubble.assistant.needs.topical') && ${bubble('cookie scope')}.querySelector('.need-pill').textContent === 'needs you'`));
        assert.ok(await page.ev(`${bubble('push the branch')}.matches('.fyi')`), 'a plain reply is FYI');
        assert.ok(await page.ev(`getComputedStyle(${bubble('cookie scope')}).borderLeftWidth === '3px'`));
    },

    'TLDR folds the rest of the message': async ({ page, open }) => {
        await open();
        await ready(page);
        const b = bubble('tag the release');
        assert.equal(await page.ev(`${b}.querySelector('.lead').textContent`), 'Should I tag the release now or wait for QA?');
        assert.equal(await page.ev(`${b}.querySelector('.body').hidden`), true);
        assert.equal(await page.ev(`${b}.querySelector('button.show').textContent`), 'Show more');
        await page.clickOn(`${b}.querySelector('button.show')`);
        await page.waitFor(`!${b}.querySelector('.body').hidden && ${b}.querySelector('button.show').textContent === 'Show less'`, { what: 'the body to unfold' });
        assert.match(await page.ev(`${b}.querySelector('.body').textContent`), /The notes cover the login redirect/);
    },

    'quick replies under a closing question send as an answer tag': async ({ page, open, IDS }) => {
        await open();
        await ready(page);
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('#feed .replies wa-button')].map(b => b.textContent)`), ['Yes', 'Do both', 'No']);
        await page.click('#feed .replies wa-button:last-child');
        await page.waitFor(`${bubble('tag the release')}.querySelector('.answer')?.textContent === '✕ You: No · sending…'`, { what: 'the answer tag' });
        assert.deepEqual(page.posts.map(p => [new URL(p.url).pathname + new URL(p.url).search, p.body]), [[`/api/send?id=${IDS.master}`, 'No']]);
        assert.equal(await page.ev(`document.querySelector('#feed .replies')`), null, 'chips gone once answered');
    },

    'a short reply becomes the answer tag of the question before it': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.equal(await page.ev(`${bubble('push the branch')}.querySelector('.answer.yes').textContent`), '✓ You: yes');
        assert.equal(await page.ev(`[...document.querySelectorAll('#feed .bubble.user')].some(b => b.textContent.trim() === 'yes')`), false, 'no bubble of its own');
    },

    'an API error shows as a red line': async ({ page, open }) => {
        await open();
        await ready(page);
        assert.equal(await page.ev(`document.querySelector('#feed .tools.api-error').textContent`), 'API Error: 529 Overloaded · please retry');
        const [r, g, b] = (await page.ev(`getComputedStyle(document.querySelector('#feed .api-error')).color`)).match(/\d+/g).map(Number);
        assert.ok(r > 150 && g < 100 && b < 100, `red, got rgb(${r}, ${g}, ${b})`);
    }
};
