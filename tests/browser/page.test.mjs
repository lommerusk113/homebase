import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

export default {
    'loads with no console errors, no CSP violations and nothing leaving localhost': async ({ page, open }) => {
        await open();
        // board, pill, chat and one full poll cycle
        await page.waitFor(`document.querySelector('.ms-pick summary .t')?.textContent === 'Sprint 12'`, { what: 'the milestone pill' });
        await page.waitFor(`document.querySelectorAll('#feed .bubble').length > 3`, { what: 'chat bubbles' });
        await sleep(3500);
        assert.deepEqual(await page.ev(`['wa-select', 'wa-button', 'wa-textarea', 'wa-details'].filter(n => !customElements.get(n))`), [], 'Web Awesome components defined');
        assert.equal(await page.ev(`typeof marked + typeof DOMPurify`), 'objectfunction');
        assert.deepEqual(page.errors, []);
        assert.deepEqual(await page.ev('window.__csp'), []);
        assert.deepEqual(page.external, []);
        assert.ok(page.requests.length > 10, 'requests were seen');
    }
};
