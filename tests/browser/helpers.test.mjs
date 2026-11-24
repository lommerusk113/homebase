import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

// Work helpers in their own chats (server/helpers.mjs). The list is patched so `other` (an alpha chat) is a helper of the
// master: the server's side of that (nestHelpers) is unit-tested in tests/unit/work-helpers.mjs.
const KEY = 'helper-row';
const row = `document.querySelector('#masters tr[data-key="${KEY}"]')`;
const back = `document.getElementById('c-back')`;

// every /api/sessions answer from now on: `other` is the master's helper, with a row nested under the master
const asHelper = (IDS, closed) => `(() => { const f = window.fetch; window.fetch = async (u, o) => {
    const r = await f(u, o);
    if (!String(u).startsWith('/api/sessions')) return r;
    const j = await r.json(), m = j.find(s => s.id === '${IDS.master}'), h = j.find(s => s.id === '${IDS.other}');
    Object.assign(h, { parentId: m.id, helper: { closed: ${JSON.stringify(closed)}, tmux: 'cc-aaaaaaaa' } });
    const base = m.items.find(i => i.agentId === 'agent-run');
    m.items.push({ ...base, key: '${KEY}', pr: null, prState: null, title: 'Tidy the cache', agentId: h.id, agentDescription: 'Tidy the cache',
        agentStatus: ${closed ? "'done'" : "'running'"}, helperSession: h.id, helperClosed: ${!!closed}, action: null, gate: null });
    return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
}; })()`;

export default {
    'a helper in its own chat nests under its parent, steps in with Back to the parent, and stops after a confirm while working': async ({ page, open, IDS }) => {
        await open();
        await page.ev(asHelper(IDS, null));
        await page.waitFor(`${row}?.querySelector('wa-button.stop-btn')`, { what: "the helper's row with Stop" });
        assert.equal(await page.ev(`${row}.querySelector('wa-button.stop-btn').title`), 'Stop this helper · tmux attach -t cc-aaaaaaaa');
        assert.equal(await page.ev(`!!document.querySelector('#masters tr[data-key="working:${IDS.other}"], #masters tr[data-key="asking:${IDS.other}"]')`), false, 'no chat row of its own');

        // while it works, Stop asks first: declined, nothing is sent; confirmed, the stop goes out
        await page.ev(`window.confirm = () => false`);
        await page.clickOn(`${row}.querySelector('wa-button.stop-btn')`);
        assert.ok(!page.posts.some(p => p.url.includes('/api/helpers/stop')), 'declined: not stopped');
        await page.ev(`window.confirm = () => true`);
        await page.clickOn(`${row}.querySelector('wa-button.stop-btn')`);
        for (let i = 0; i < 50 && !page.posts.some(p => p.url.includes('/api/helpers/stop')); i++) {
            await sleep(100);
        }
        assert.ok(page.posts.some(p => p.url.includes(`/api/helpers/stop?id=${IDS.other}`)), 'stopped by its id');

        // step in: the helper's own chat, Back returns to the parent (the main chat here, so the focus ends)
        await page.clickOn(`${row}.querySelector('wa-button.step-in')`);
        await page.waitFor(`import('/core.js').then(m => m.state.focus === '${IDS.other}') && !${back}.hidden`, { what: "the helper's chat in the pane" });
        assert.ok((await page.ev(`document.getElementById('c-name').textContent`)).startsWith('Helper · '));
        assert.notEqual(await page.ev(`${back}.textContent`), '← Back to main');
        assert.equal(await page.ev(`document.getElementById('msg').disabled`), false, 'an open helper takes messages');
        await page.click('#c-back');
        await page.waitFor(`import('/core.js').then(m => m.state.focus === null) && ${back}.hidden`, { what: 'the parent back' });
    },

    'a closed helper stays under its parent, read-only, without Stop': async ({ page, open, IDS }) => {
        const note = 'Closed — ask the main chat to start a new helper on branch helper/tidy';
        await open();
        await page.ev(asHelper(IDS, note));
        await page.waitFor(`${row}?.querySelector('wa-button.step-in')`, { what: "the closed helper's row" });
        assert.equal(await page.ev(`!!${row}.querySelector('wa-button.stop-btn')`), false, 'no Stop once closed');
        await page.clickOn(`${row}.querySelector('wa-button.step-in')`);
        await page.waitFor(`document.getElementById('msg').getAttribute('placeholder') === ${JSON.stringify(note)}`, { what: "the composer's closed note" });
        assert.equal(await page.ev(`document.getElementById('msg').disabled`), true);
    }
};
