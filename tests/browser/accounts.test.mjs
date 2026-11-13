import assert from 'node:assert/strict';
import { TRACKER_PR, OTHER_PR } from './fixture.mjs';

const row = key => `document.querySelector('#masters tr[data-key="${key}"]')`;

export default {
    'a personal GitHub repo (SSH host alias) shows its PR through the keychain token, with a Merge button when ready': async ({ page, open }) => {
        await open({ tracked: '["alpha","beta","gamma","tracker"]', project: 'tracker' });
        await page.waitFor(`${row(TRACKER_PR)}?.querySelector('b').textContent === 'Fix the tracker sync'`, { what: 'the tracker PR row with its real title' });
        assert.equal(await page.ev(`${row(TRACKER_PR)}.querySelector('.act-btn').textContent`), 'Merge + close issue');
    },

    'a PR another repo\'s link quoted in a session does not show under the project': async ({ page, open }) => {
        await open({ tracked: '["alpha","beta","gamma","tracker"]', project: 'tracker' });
        await page.waitFor(`${row(TRACKER_PR)}?.querySelector('b').textContent === 'Fix the tracker sync'`, { what: 'the tracker PR row' });
        assert.equal(await page.ev(`${row(OTHER_PR)}`), null, 'no homebase PR on the tracker board');
        assert.equal(await page.ev(`document.querySelectorAll('#masters tr[data-key^="https://"]').length`), 1);
    }
};
