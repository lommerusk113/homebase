import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

export default {
    'loads with no console errors, no CSP violations and nothing leaving localhost': async ({ page, open }) => {
        await open();
        // board, pill, chat and one full poll cycle
        await page.waitFor(`document.querySelector('.ms-pick summary .t')?.textContent === 'Sprint 12'`, { what: 'the milestone pill' });
        await page.waitFor(`document.querySelectorAll('#feed .bubble').length > 3`, { what: 'chat bubbles' });
        await sleep(3500);
        assert.deepEqual(await page.ev(`['wa-button', 'wa-textarea', 'wa-details'].filter(n => !customElements.get(n))`), [], 'Web Awesome components defined');
        assert.equal(await page.ev(`typeof marked + typeof DOMPurify`), 'objectfunction');
        assert.deepEqual(page.errors, []);
        assert.deepEqual(await page.ev('window.__csp'), []);
        assert.deepEqual(page.external, []);
        assert.ok(page.requests.length > 10, 'requests were seen');
    },

    // names in the accessibility tree, as a screen reader gets them: present, whatever their wording
    'the composer, the project button, the board tables, the chat pane and the waiting row have accessible names': async ({ page, open, IDS }) => {
        await open();
        await page.waitFor(`document.querySelector('#masters tr[data-key="asking:${IDS.master}"]') && document.getElementById('project').textContent.includes('alpha')`, { what: 'the board' });
        await page.cmd('Accessibility.enable');
        const { nodes } = await page.cmd('Accessibility.getFullAXTree');
        const of = role => nodes.filter(n => !n.ignored && n.role?.value === role).map(n => n.name?.value ?? '');
        assert.ok(of('textbox').length && of('textbox').every(Boolean), `every textbox is named: ${JSON.stringify(of('textbox'))}`);
        assert.ok(of('button').some(n => /project/i.test(n) && n.includes('alpha')), 'the project button names the project');
        assert.ok(of('grid').length && of('grid').every(Boolean), `every board table is named: ${JSON.stringify(of('grid'))}`);
        assert.ok(of('complementary').every(Boolean), 'the chat pane is named');
        assert.equal(of('main').length, 1, 'one main landmark');
        assert.ok(of('heading').length && nodes.some(n => n.role?.value === 'heading' && n.properties?.some(p => p.name === 'level' && p.value.value === 1)), 'a level 1 heading');
        const row = nodes.filter(n => !n.ignored && n.role?.value === 'button' && /tag the release/.test(n.name?.value ?? ''));
        assert.ok(row.length && row.every(n => !/^Mark as handled/.test(n.name.value)), 'the waiting row is named by its question, not by the button inside it');
        await page.cmd('Accessibility.disable');
    },
};
