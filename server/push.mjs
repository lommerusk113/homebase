// Web Push on node:crypto and node:https: VAPID keys and JWT (RFC 8292), aes128gcm payload encryption (RFC 8291),
// sending, the subscription store, and which session transitions are worth a push.
import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign } from 'node:crypto';
import { request } from 'node:https';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { waitsOnYou } from '../public/core.js';

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(s, 'base64url');

// VAPID key pair, made once and kept in the Homebase dir (0600): { publicKey, privateKey } as base64url raw P-256 bytes.
const vapidCache = new Map();
export function vapidKeys(dir) {

    if (!vapidCache.has(dir)) {
        vapidCache.set(dir, (async () => {
            const file = join(dir, 'vapid.json');
            try {
                return JSON.parse(await readFile(file, 'utf8'));
            } catch {}
            const ecdh = createECDH('prime256v1');
            ecdh.generateKeys();
            const keys = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
            await mkdir(dir, { recursive: true });
            await writeFile(file, JSON.stringify(keys), { mode: 0o600, flag: 'wx' }).catch(e => {
                if (e.code !== 'EEXIST') {
                    throw e;
                }
            });
            return JSON.parse(await readFile(file, 'utf8')); // a parallel start may have won the race
        })());
    }

    return vapidCache.get(dir);
}

// ES256 JWT for the push service at `audience` (its origin), valid 12h. Apple refuses a sub that isn't a mailto: or https URL.
export function vapidJwt(audience, keys, now = Date.now(), sub = 'mailto:homebase@example.com') {

    const pub = unb64u(keys.publicKey);
    const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
    const data = `${b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))}.${b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub }))}`;

    return `${data}.${b64u(sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }))}`;
}

// RFC 8291: one aes128gcm record. salt and the sender's key pair are random unless given (the test vector).
export function encrypt(payload, { p256dh, auth }, { salt = randomBytes(16), privateKey } = {}) {

    const ecdh = createECDH('prime256v1');
    if (privateKey) {
        ecdh.setPrivateKey(privateKey);
    } else {
        ecdh.generateKeys();
    }
    const uaPublic = unb64u(p256dh), asPublic = ecdh.getPublicKey();
    const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(uaPublic), unb64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const cipher = createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(4096);

    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

const httpsPost = (url, headers, body) => new Promise((ok, fail) => {
    const req = request(url, { method: 'POST', headers, timeout: 10_000 }, res => {
        res.resume();
        ok(res.statusCode);
    });
    req.on('timeout', () => req.destroy(new Error('push timed out')));
    req.on('error', fail);
    req.end(body);
});

// One push; resolves to the push service's status code.
export async function pushTo(sub, payload, keys, post = httpsPost) {

    const body = encrypt(JSON.stringify(payload), sub.keys);

    return post(sub.endpoint, {
        authorization: `vapid t=${vapidJwt(new URL(sub.endpoint).origin, keys)}, k=${keys.publicKey}`,
        ttl: '3600',
        urgency: 'high',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        'content-length': body.length
    }, body);
}

// Subscriptions only point at the big push services: the server POSTs to whatever endpoint is stored.
// ponytail: fixed host list; add a host here if another browser's push service shows up
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
export function validSub(sub) {

    let url;
    try {
        url = new URL(sub?.endpoint);
    } catch {
        return false;
    }
    const p = typeof sub.keys?.p256dh === 'string' && unb64u(sub.keys.p256dh), a = typeof sub.keys?.auth === 'string' && unb64u(sub.keys.auth);

    return url.protocol === 'https:' && PUSH_HOSTS.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))
        && p?.length === 65 && p[0] === 4 && a?.length === 16 && sub.endpoint.length < 1024;
}

// subscriptions.json in the Homebase dir (0600). Writes run one at a time, newest 20 kept.
let chain = Promise.resolve();
export async function readSubs(dir) {

    try {
        return JSON.parse(await readFile(join(dir, 'subscriptions.json'), 'utf8'));
    } catch {
        return [];
    }
}
function updateSubs(dir, fn) {

    chain = chain.catch(() => {}).then(async () => {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'subscriptions.json'), JSON.stringify(fn(await readSubs(dir)).slice(-20)), { mode: 0o600 });
    });

    return chain;
}
// device: the paired device's id for a remote subscription, so revoking the device drops it too.
export const addSub = (dir, { endpoint, keys: { p256dh, auth } }, device) => updateSubs(dir, subs => [...subs.filter(s => s.endpoint !== endpoint), { endpoint, keys: { p256dh, auth }, ...(device ? { device } : {}) }]);
export const removeSub = (dir, endpoint) => updateSubs(dir, subs => subs.filter(s => s.endpoint !== endpoint));
export const removeDeviceSubs = (dir, device) => updateSubs(dir, subs => subs.filter(s => s.device !== device));

export const DEBOUNCE_MS = 30_000;
// Sessions that started waiting on you since the previous check (core.js waitsOnYou, as list.js askingEvents), at most
// one per session per DEBOUNCE_MS (`sent` holds when each last got one). No previous check, no events.
export function pushEvents(prev, list, sent, now = Date.now()) {

    const next = new Set(list.filter(waitsOnYou).map(s => s.id));
    const events = !prev ? [] : list.filter(s => next.has(s.id) && !prev.has(s.id) && !(now - (sent.get(s.id) ?? -Infinity) < DEBOUNCE_MS));
    for (const s of events) {
        sent.set(s.id, now);
    }

    return {
        next,
        events: events.map(s => ({
            title: `${s.project ?? 'Homebase'} needs you`,
            body: String((s.asking ? s.question : s.lastReply) ?? 'Waiting on you').slice(0, 300),
            tag: s.id,
            chat: s.id
        }))
    };
}

// The server's watcher: fed every sessions list, it pushes new transitions to every device, unless a page was focused in
// the last minute. Subscriptions the push service says are gone (404/410) are dropped.
const watch = { prev: null, sent: new Map(), focusedAt: -Infinity, at: 0 };
export const pageFocused = (now = Date.now()) => { watch.focusedAt = now; };
export const watchedAt = () => watch.at;
export async function watchSessions(dir, list, now = Date.now(), post = httpsPost) {

    watch.at = now;
    const { next, events } = pushEvents(watch.prev, list, watch.sent, now);
    watch.prev = next;
    if (!events.length || now - watch.focusedAt < 60_000) {
        return;
    }

    const subs = await readSubs(dir);
    if (!subs.length) {
        return;
    }
    const keys = await vapidKeys(dir);
    await Promise.all(subs.flatMap(sub => events.map(async e => {
        const code = await pushTo(sub, e, keys, post).catch(err => console.error(`push failed: ${err.message}`));
        if (code === 404 || code === 410) {
            await removeSub(dir, sub.endpoint);
        }
    })));
}
