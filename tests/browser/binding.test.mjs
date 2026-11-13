import assert from 'node:assert/strict';
import { sleep } from './cdp.mjs';

export default {
    'the chat stays on its bound session when another session gets newer': async ({ page, open, IDS, touchSession }) => {
        await open();
        await page.waitFor(`document.getElementById('feed').textContent.includes('tag the release')`, { what: 'the master chat' });
        touchSession('alpha', IDS.other, 'Fresh reply in the other session');
        // the board has the other session as the newest one...
        await page.waitFor(`import('/core.js').then(m => m.state.sessions[0]?.id === ${JSON.stringify(IDS.other)})`, { what: 'the other session to be newest' });
        await sleep(3500); // ...and a chat poll has run since
        assert.match(await page.ev(`[...document.querySelectorAll('#feed .bubble.assistant')].at(-1).textContent`), /tag the release/);
        assert.equal(await page.ev(`document.getElementById('feed').textContent.includes('Fresh reply')`), false);
        assert.equal(await page.ev(`localStorage.getItem('chat')`), IDS.master);
    }
};
