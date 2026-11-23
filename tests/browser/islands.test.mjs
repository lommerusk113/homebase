import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const BUILT = existsSync(new URL('../../web/dist/main.js', import.meta.url));
const badge = `document.querySelector('[data-island="demo"] [data-slot="badge"]')?.textContent`;
const visible = `import('/core.js').then(c => c.visibleSessions().length + ' chats')`;

export default {
    // the bridge (web/src/old.ts): the island reads the old state and calls an old action, and follows the change
    '?vue=1 mounts the demo island, which follows the old state and calls an old action': async ({ page, open, base }) => {
        if (!BUILT) {
            console.log('     skipped: web/ is not built (cd web && npm ci && npm run build)');
            return;
        }
        await open({ project: 'alpha' });
        await page.goto(`${base}?vue=1`);
        await page.waitFor(`document.querySelector('#masters tr[data-key]') && ${badge}`, { what: 'the board and the island' });
        const alpha = await page.ev(visible);
        await page.waitFor(`${badge} === ${JSON.stringify(alpha)}`, { what: `the badge to say ${alpha}` });
        await page.click('[data-island="demo"] [data-slot="button"]');
        await page.waitFor(`document.getElementById('project').textContent.includes('All')`, { what: 'the old picker to follow' });
        const all = await page.ev(visible);
        assert.notEqual(all, alpha, 'the fixture has chats outside alpha');
        await page.waitFor(`${badge} === ${JSON.stringify(all)}`, { what: `the badge to say ${all}` });
        assert.deepEqual(page.errors, []);
    }
};
