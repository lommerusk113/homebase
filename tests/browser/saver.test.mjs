import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const sw = `document.getElementById('saver-switch')`;

export default {
    // The /api/saver POST reaches the server; it writes only token-saver.md in the test's data dir.
    'the Token saver switch is off at first, flips on, and stays on after a reload': async ({ page, open, base, answerPosts, homebase }) => {
        const file = join(homebase, 'token-saver.md');
        rmSync(file, { force: true });
        await open();
        page.route = q => (q.url.includes('/api/saver') ? null : answerPosts(q));
        await page.waitFor(`${sw} && ${sw}.textContent.trim() === 'Token saver' && document.getElementById('saver').nextElementSibling === null`, { what: 'the switch in the footer' });
        assert.equal(await page.ev(`${sw}.checked`), false, 'off by default');
        await page.click('#saver-switch');
        await page.waitFor(`${sw}.checked === true`, { what: 'the switch on' });
        await page.waitFor(`import('/core.js').then(c => c.api('/api/saver')).then(r => r.json()).then(j => j.on)`, { what: 'the server to know' });
        assert.match(readFileSync(file, 'utf8'), /^Token saver is on: start every helper \(Agent tool\) with model: sonnet/);
        await page.goto(base);
        await page.waitFor(`${sw}?.checked === true`, { what: 'the switch still on after a reload' });
        await page.click('#saver-switch');
        await page.waitFor(`${sw}.checked === false`, { what: 'the switch off again' });
        await page.waitFor(`import('/core.js').then(c => c.api('/api/saver')).then(r => r.json()).then(j => !j.on)`, { what: 'the server to know' });
        assert.deepEqual(page.errors, []);
        rmSync(file, { force: true });
    }
};
