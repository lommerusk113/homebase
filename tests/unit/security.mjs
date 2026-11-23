import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { vendorPath, localHosts, allowedHost, allowedOrigin, tokenOk, remoteFrom, setupPairing, newCode, pair, deviceOf, cookieOf, deviceCookie, pairedDevices, revoke, isRemote, loginOk, isPairedRequest, CODE_TTL_MS, MAX_FAILS, FAIL_WINDOW_MS } from '../../server.mjs';

assert.equal(vendorPath('/vendor/webawesome/webawesome.loader.js'), 'webawesome/webawesome.loader.js');
assert.equal(vendorPath('/vendor/fonts/inter-latin-400-normal.woff2'), 'fonts/inter-latin-400-normal.woff2');
assert.equal(vendorPath('/vendor/a%20b.css'), 'a b.css');
for (const p of [
    '/vendor/../server.mjs', '/vendor/%2e%2e/server.mjs', '/vendor/%2E%2E%2Fserver.mjs', '/vendor/a/..%2f..%2fserver.mjs',
    '/vendor/..%5c..%5cserver.js', '/vendor/a%00.js', '/vendor/%E0%A4%A.js', '/vendor//etc/x.js', '/vendor/.hidden.js',
    '/vendor/VENDOR.md', '/vendor/x.html', '/vendor/', '/vendor', '/vendorx/a.js', '/server.mjs', null
]) {
    assert.equal(vendorPath(p), null, p);
}
console.log('ok vendor');

// Every request from the page goes through core.js's api(), which adds the token; a missing import fails silently in a try/catch.
for (const f of readdirSync(new URL('../../public', import.meta.url)).filter(f => f.endsWith('.js') && f !== 'core.js')) {
    const src = readFileSync(new URL(`../../public/${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\bfetch\(/, `${f} uses fetch() instead of api()`);
    if (/\bapi\(/.test(src)) {
        assert.match(src, /import \{[^}]*\bapi\b[^}]*\} from '\.\/core\.js'/, `${f} calls api() without importing it`);
    }
}
console.log('ok api wrapper');

{
    const local = localHosts(4321);
    assert.ok(allowedHost('localhost:4321', local));
    assert.ok(allowedHost('127.0.0.1:4321', local));
    assert.ok(allowedHost('[::1]:4321', local));
    assert.ok(!allowedHost('evil.com', local));
    assert.ok(!allowedHost('localhost:4322', local));
    assert.ok(!allowedHost('localhost', local));
    assert.ok(!allowedHost(undefined, local));
    assert.ok(allowedOrigin(undefined, local));
    assert.ok(allowedOrigin('http://localhost:4321', local));
    assert.ok(allowedOrigin('http://127.0.0.1:4321', local));
    assert.ok(!allowedOrigin('http://evil.com', local));
    assert.ok(!allowedOrigin('null', local));
    assert.ok(!allowedOrigin('https://localhost:4321', local));
    assert.ok(tokenOk('abc', 'abc'));
    assert.ok(!tokenOk('abd', 'abc'));
    assert.ok(!tokenOk('ab', 'abc'));
    assert.ok(!tokenOk(undefined, 'abc'));
    assert.ok(!tokenOk('abc', undefined));
    // the remote host: exact name only, https (or http) origin, never another ts.net name
    const ts = ['mac.tail1.ts.net'];
    assert.ok(allowedHost('mac.tail1.ts.net', ts));
    assert.ok(!allowedHost('other.tail1.ts.net', ts) && !allowedHost('localhost:4321', ts) && !allowedHost('mac.tail1.ts.net', local));
    assert.ok(allowedOrigin('https://mac.tail1.ts.net', ts, ['https', 'http']));
    assert.ok(!allowedOrigin('https://mac.tail1.ts.net', ts)); // http only by default
    assert.ok(!allowedOrigin('https://evil.ts.net', ts, ['https', 'http']));
}
console.log('ok access checks');

{
    // config: exact host, port defaults to PORT + 1, no wildcard or junk
    assert.equal(remoteFrom({}, 4321), null);
    assert.deepEqual(remoteFrom({ remote: { host: 'Mac.Tail1.ts.net' } }, 4321), { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    assert.deepEqual(remoteFrom({ remote: { host: 'mac.tail1.ts.net', port: 5000, login: 'me@x.com' } }, 4321), { host: 'mac.tail1.ts.net', port: 5000, login: 'me@x.com' });
    for (const bad of [{ host: '*.ts.net' }, { host: '' }, {}, { host: 'a b' }, { host: 'mac.ts.net', port: 4321 }, { host: 'mac.ts.net', port: '1' }, { host: 'mac.ts.net', login: 1 }, null]) {
        assert.throws(() => remoteFrom({ remote: bad }, 4321), /remote must be/, JSON.stringify(bad));
    }

    const dir = mkdtempSync(join(tmpdir(), 'homebase-pair-')), file = join(dir, 'devices.json');
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    const t = 1_000_000;
    // no code yet, then a wrong one: 401
    assert.throws(() => pair('123456', 'x', t), e => e.status === 401);
    const { code, expiresAt } = newCode(t);
    assert.match(code, /^\d{6}$/);
    assert.equal(expiresAt, t + CODE_TTL_MS);
    // expired
    assert.throws(() => pair(code, 'Phone', t + CODE_TTL_MS), e => e.status === 401);
    // rate limit: MAX_FAILS wrong tries in a window, then even the right code is refused until the window passes
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: '' });
    const c2 = newCode(t).code, wrong = c2 === '000000' ? '000001' : '000000';
    for (let i = 0; i < MAX_FAILS; i++) {
        assert.throws(() => pair(wrong, 'x', t + i), e => e.status === 401);
    }
    assert.throws(() => pair(c2, 'x', t + MAX_FAILS), e => e.status === 429);
    const later = t + MAX_FAILS + FAIL_WINDOW_MS;
    const secret = pair(` ${c2} `, ' My\u0007 phone ', later);
    assert.match(secret, /^[0-9a-f]{64}$/);
    // single use
    assert.throws(() => pair(c2, 'again', later), e => e.status === 401);
    // only the hash is stored
    const stored = readFileSync(file, 'utf8');
    assert.ok(!stored.includes(secret));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const [dev] = pairedDevices();
    assert.deepEqual(Object.keys(dev).sort(), ['created', 'id', 'lastSeen', 'name']);
    assert.equal(dev.name, 'My phone');
    // cookie: parse, flags, lookup, lastSeen
    const cookie = deviceCookie(secret);
    assert.match(cookie, /^homebase_device=[0-9a-f]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal(cookieOf(`a=1; homebase_device=${secret}; b=2`), secret);
    assert.equal(cookieOf('a=1'), null);
    assert.equal(deviceOf(secret, later).id, dev.id);
    assert.equal(deviceOf('f'.repeat(64), later), null);
    assert.equal(deviceOf('nothex', later), null);
    assert.equal(deviceOf(secret, later + 120_000).lastSeen, later + 120_000);
    // survives a restart (re-read from disk)
    setupPairing(file, { host: 'mac.tail1.ts.net', port: 4322, login: 'me@x.com' });
    assert.equal(pairedDevices()[0].lastSeen, later + 120_000);
    // requests: local ones always pass; remote ones need the login (when set) and a paired cookie
    const req = (localPort, headers = {}) => ({ socket: { localPort }, headers });
    assert.ok(!isRemote(req(4321)) && isRemote(req(4322)));
    assert.ok(isPairedRequest(req(4321)));
    assert.ok(!isPairedRequest(req(4322)));
    assert.ok(!isPairedRequest(req(4322, { cookie: `homebase_device=${secret}` })), 'login missing');
    assert.ok(!loginOk(req(4322, { 'tailscale-user-login': 'evil@x.com' })));
    assert.ok(isPairedRequest(req(4322, { cookie: `homebase_device=${secret}`, 'tailscale-user-login': 'me@x.com' })));
    // revoke
    assert.equal(revoke('nope'), false);
    assert.equal(revoke(dev.id), true);
    assert.deepEqual(pairedDevices(), []);
    assert.ok(!isPairedRequest(req(4322, { cookie: `homebase_device=${secret}`, 'tailscale-user-login': 'me@x.com' })));
    // no remote config: nothing is remote
    setupPairing(file, null);
    assert.ok(!isRemote(req(4322)) && loginOk(req(4322)));
    rmSync(dir, { recursive: true, force: true });
}
console.log('ok pairing');
