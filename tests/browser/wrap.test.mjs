import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';

// Nothing in the page scrolls or overflows sideways: long content wraps. The feed gets the worst cases injected
// (the page redraws it whole on the next poll, so measure right after).
const LONG = 'x'.repeat(300);
const content = `(() => {
    const feed = document.getElementById('feed');
    const add = html => feed.insertAdjacentHTML('beforeend', html);
    add('<div class="tools risky">Ran: git commit -q -m "## - ${LONG}" -- frontend/${LONG}/file.js</div>');
    add('<div class="bubble assistant"><div class="lead">Branch 99-${LONG} at https://example.com/${LONG}</div><div class="body">' +
        '<pre><code>const veryLongLine = "${LONG}${LONG}";</code></pre>' +
        '<p><a href="https://example.com/${LONG}">https://example.com/${LONG}</a></p>' +
        '<table><tr><th>Path</th><th>Note</th></tr><tr><td>${LONG}</td><td>${LONG}</td></tr></table></div></div>');
    add('<div class="bubble user">${LONG}</div>');
    const branch = document.querySelector('.c-branch');
    if (branch) { branch.hidden = false; branch.textContent = '12-${LONG}'; }
})()`;
const wide = `[document.documentElement, document.body, ...document.querySelectorAll('.main, #chat, #feed, #feed .bubble, #feed .tools, #feed .body *, .c-cards, #masters, #masters *')]
    .filter(e => e.offsetParent !== null || e === document.body || e === document.documentElement)
    // ellipsis truncation (header chips, board cells) is by design, as long as nothing pushes past the viewport
    .filter(e => (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis' && !e.closest('#masters')) || e.getBoundingClientRect().right > innerWidth + 1)
    .map(e => (e.id || e.className || e.tagName) + ':' + e.scrollWidth + '>' + e.clientWidth)`;
const SHOTS = '/private/tmp/claude-501/-Users-bruinen-IdeaProjects-Privat-codetool/a0da2e79-0e88-4132-aa8a-4f82c6fe07ad/scratchpad';

export default {
    'long commands, code, URLs, branches and tables wrap instead of overflowing, at 1440px and 390px': async ({ page, open }) => {
        await open();
        await page.waitFor(`document.querySelector('#feed .bubble')`, { what: 'the feed' });
        try {
            for (const [w, mobile] of [[1440, false], [390, true]]) {
                await page.cmd('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile });
                await page.ev(content);
                assert.deepEqual(await page.ev(wide), [], `chat at ${w}px`);
                if (process.env.WRAP_SHOTS) {
                    const shot = await page.cmd('Page.captureScreenshot', { format: 'png' });
                    writeFileSync(`${SHOTS}/wrap-${w}.png`, Buffer.from(shot.data, 'base64'));
                }
                if (mobile) {
                    await page.click('#ptabs [data-pane="work"]');
                    await page.waitFor(`document.getElementById('masters').offsetParent !== null`, { what: 'the board' });
                }
                assert.deepEqual(await page.ev(wide), [], `board at ${w}px`);
            }
        } finally {
            await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }); // the harness's size (cdp.mjs)
        }
    }
};
