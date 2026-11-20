import assert from 'node:assert/strict';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/browser-test';

export default {
    'the service worker registers at / and the menu item subscribes this device': async ({ page, open }) => {
        await open();
        await page.waitFor(`navigator.serviceWorker.getRegistration().then(r => r?.active?.scriptURL.endsWith('/sw.js') && r.scope === location.origin + '/')`, { what: 'sw.js active with scope /' });
        await page.waitFor(`document.getElementById('push-state').textContent === 'Off'`, { what: 'the Off state' });
        // the push service is stubbed: headless Chrome has none, and nothing may leave the machine
        await page.ev(`(() => {
            let sub = null;
            Notification.requestPermission = async () => 'granted';
            PushManager.prototype.getSubscription = async () => sub;
            PushManager.prototype.subscribe = async opts => {
                window.subscribedKey = opts.applicationServerKey.length;
                sub = { endpoint: '${ENDPOINT}', toJSON: () => ({ endpoint: '${ENDPOINT}', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { sub = null; return true; } };
                return sub;
            };
        })()`);
        await page.click('#c-menu button[slot="trigger"]');
        await page.clickOn(`document.getElementById('push-item')`);
        await page.waitFor(`document.getElementById('push-state').textContent === 'On'`, { what: 'the On state' });
        assert.equal(await page.ev('window.subscribedKey'), 65, 'the VAPID public key from /api/push/key');
        const posts = page.posts.filter(p => new URL(p.url).pathname === '/api/push/subscribe');
        assert.equal(posts.length, 1);
        assert.deepEqual(JSON.parse(posts[0].body), { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } });
        assert.equal(await page.ev(`document.getElementById('push-label').textContent`), 'Turn off notifications on this device');
    },

    'a ?chat= link (a notification click) opens that chat': async ({ page, open, base, IDS }) => {
        await open({ project: 'alpha' });
        await page.goto(`${base}?chat=${IDS.asker}`);
        await page.waitFor(`localStorage.getItem('chat') === '${IDS.asker}' && localStorage.getItem('project') === 'beta' && location.search === ''`, { what: 'the beta asker chat bound' });
    }
};
