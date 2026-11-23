import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { refetch, refreshDue, swrEntry, swr, cached, refreshAll, refreshInfo, limiter, dedupe } from '../../server.mjs';
import { request } from 'node:http';
import { createServer as netServer } from 'node:net';
import { codeDir } from './helpers.mjs';

{
    // the old value serves until the new one lands; a second call while in flight shares the fetch
    let calls = 0, release;
    const hit = { at: 5, value: 'old' }, fn = () => { calls++; return new Promise(r => { release = r; }); };
    const p = refetch(hit, fn);
    assert.equal(refetch(hit, fn), p);
    assert.equal(calls, 1);
    assert.equal(hit.value, 'old');
    release('new'); await p;
    assert.equal(hit.value, 'new');
    assert.equal(hit.pending, null);
    assert.ok(hit.at > 5);
    // a failure keeps the value and records the error
    await refetch(hit, () => Promise.reject(new Error('down')));
    assert.equal(hit.value, 'new');
    assert.equal(hit.error.message, 'down');

    assert.ok(refreshDue(false, 0, 10_000));
    assert.ok(!refreshDue(true, 0, 10_000)); // one running
    assert.ok(!refreshDue(false, 6_000, 10_000)); // started 4 s ago
    assert.ok(refreshDue(false, 5_000, 10_000));
}
console.log('ok refresh');

{
    // refreshAll: the other cache entries first, the issue groups once those are in; concurrent calls share one run
    const order = [];
    let linkCalls = 0, release;
    const links = () => {
        order.push('links');
        return linkCalls++ ? new Promise(r => { release = r; }) : Promise.resolve(1);
    };
    const issues = () => {
        order.push('issues');
        return Promise.resolve(2);
    };
    await swrEntry('links:p:1', 1e9, links).pending;
    await swrEntry('issues:p:11', 1e9, issues).pending;
    order.length = 0;
    const run = refreshAll();
    assert.equal(refreshAll(), run);
    await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(order, ['links']);
    assert.equal(refreshInfo().refreshing, true);
    release(1);
    await run;
    assert.deepEqual(order, ['links', 'issues']);
    assert.equal(refreshInfo().refreshing, false);

    // cached: only the first load waits, a stale entry answers with the old value at once, a failed first load throws
    assert.equal(await cached('t:a', 0, () => Promise.resolve(1)), 1);
    let settled = false;
    const stale = cached('t:a', -1, () => new Promise(() => {})).then(v => {
        settled = true;
        return v;
    });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(settled, true);
    assert.equal(await stale, 1);
    await assert.rejects(cached('t:b', 1e9, () => Promise.reject(new Error('down'))), /down/);
    for (const k of ['links:p:1', 'issues:p:11', 't:a', 't:b']) {
        swr.delete(k);
    }
}
console.log('ok refreshAll, cached');


// Integration: real server on a random port, over a temp HOME and data dir and a tmux socket nobody uses. Only GETs, rejected POSTs and a refresh with nothing to refresh.
{
    const freePort = () => new Promise(r => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const call = (port, { host, path = '/', method = 'GET', headers = {}, body, addr = '127.0.0.1' } = {}) => new Promise((ok, fail) => {
        const r = request({ host: addr, port, path, method, headers: { host: host ?? `localhost:${port}`, ...headers } }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: data }));
        });
        r.on('error', fail);
        r.end(body);
    });
    async function start(env, config) {
        const port = await freePort(), dir = mkdtempSync(join(tmpdir(), 'homebase-test-'));
        if (config) {
            writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
        }
        const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('../../', import.meta.url).pathname, env: { ...process.env, HOME: dir, PORT: String(port), HOMEBASE_DIR: dir, HOMEBASE_CODE_DIR: codeDir(join(dir, 'code')), HOMEBASE_STATUSLINE_DIR: dir, HOMEBASE_TMUX_SOCKET: 'homebase-test-none', ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        await new Promise((ok, fail) => { child.stdout.on('data', c => { out += c; if (out.includes('Homebase on')) ok(); }); child.on('exit', fail); });
        return { port, dir, out, stop: () => { child.kill(); rmSync(dir, { recursive: true, force: true }); } };
    }
    const meta = body => body.match(/name="homebase-token" content="([0-9a-f]{64})"/)?.[1];

    const s = await start({});
    try {
        assert.equal((await call(s.port, { host: 'evil.com' })).status, 403);
        assert.equal((await call(s.port, { host: 'evil.com', path: '/api/limits' })).status, 403);
        assert.equal((await call(s.port, { headers: { origin: 'http://evil.com' } })).status, 403);
        assert.equal((await call(s.port, { path: '/api/limits' })).status, 401);
        assert.equal((await call(s.port, { path: '/api/limits', headers: { 'x-homebase-token': 'f'.repeat(64) } })).status, 401);
        const page = await call(s.port);
        assert.equal(page.status, 200);
        assert.equal(page.headers['x-content-type-options'], 'nosniff');
        assert.equal(page.headers['x-frame-options'], 'DENY');
        assert.equal(page.headers['referrer-policy'], 'no-referrer');
        assert.match(page.headers['content-security-policy'], /script-src 'self';/);
        const token = meta(page.body);
        assert.ok(token, 'page carries the token');
        assert.match(page.body, /name="homebase-build" content="[\w-]{12}"/);
        assert.equal(page.headers['cache-control'], 'no-store');
        for (const path of ['/app.js', '/styles.css', '/vendor/marked/marked.min.js']) {
            const js = await call(s.port, { path });
            assert.equal(js.status, 200);
            assert.equal(js.headers['cache-control'], 'no-cache', path); // revalidate every load: no stale modules after a restart
            assert.match(js.headers.etag, /^"[\w-]+"$/, path);
            const again = await call(s.port, { path, headers: { 'if-none-match': js.headers.etag } });
            assert.equal(again.status, 304, path);
            assert.equal(again.body, '');
            assert.equal((await call(s.port, { path, headers: { 'if-none-match': '"stale"' } })).status, 200, path);
        }
        const ok = await call(s.port, { path: '/api/limits', headers: { 'x-homebase-token': token, origin: `http://localhost:${s.port}` } });
        assert.equal(ok.status, 200);
        assert.equal(ok.headers['content-type'], 'application/json');
        // POST rejection paths only: none of these reach a session.
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1' }, body: 'hi' })).status, 401);
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, 'sec-fetch-site': 'cross-site' }, body: 'hi' })).status, 403);
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, origin: 'http://evil.com' }, body: 'hi' })).status, 403);
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-codetool': '1' } })).status, 401);
        // without x-codetool a POST matches no route, even with the token
        assert.equal((await call(s.port, { path: '/api/send?id=x', method: 'POST', headers: { 'x-homebase-token': token }, body: 'hi' })).status, 404);
        assert.equal((await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-homebase-token': token } })).status, 404);
        // only known sessions and plain transcript folders; HOME is empty, so nothing reaches tmux
        const authed = { 'x-homebase-token': token };
        for (const dir of ['..', 'a%2Fb']) {
            assert.deepEqual((({ status, body }) => [status, body])(await call(s.port, { path: `/api/transcript?dir=${dir}&id=x`, headers: authed })), [400, 'bad path'], dir);
        }
        const sent = await call(s.port, { path: '/api/send?id=..%2Fx', method: 'POST', headers: { ...authed, 'x-codetool': '1' }, body: 'hi' });
        assert.deepEqual([sent.status, sent.body], [400, 'bad id']);
        for (const [tmux, want] of [['cc-abcdef01', [400, 'bad tmux name']], ['cc-new-x;y', [400, 'bad tmux name']], ['cc-new-nosuch', [409, "cc-new-nosuch isn't running"]]]) {
            const r = await call(s.port, { path: `/api/send?tmux=${encodeURIComponent(tmux)}`, method: 'POST', headers: { ...authed, 'x-codetool': '1' }, body: 'hi' });
            assert.deepEqual([r.status, r.body], want, tmux);
        }
        const refreshed = await call(s.port, { path: '/api/refresh', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token } });
        assert.equal(refreshed.status, 200);
        assert.equal(JSON.parse(refreshed.body).refreshing, false);
        assert.ok(JSON.parse(refreshed.body).lastRefreshedAt > 0);
        // an unknown project: a 404 that still carries the final empty state, so the pill stops loading
        const unknown = await call(s.port, { path: '/api/milestones?project=no-such-project-xyz&milestone=', headers: { 'x-homebase-token': token } });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.headers['content-type'], 'application/json'); // the error body is JSON too
        assert.deepEqual((({ milestones, selected, loading, reason }) => ({ milestones, selected, loading, reason }))(JSON.parse(unknown.body)),
            { milestones: [], selected: null, loading: false, reason: 'unsupported' });
    } finally { s.stop(); }
    console.log('ok server access');

    // Remote access: a second loopback port for tailscale serve; unpaired devices get only the pair page.
    const rport = await freePort(), rhost = 'mac.tail1.ts.net';
    const rs = await start({}, { remote: { host: rhost, port: rport, login: 'me@x.com' } });
    try {
        const remote = (o = {}) => call(rport, { host: rhost, ...o, headers: { 'tailscale-user-login': 'me@x.com', ...o.headers } });
        assert.match(rs.out, new RegExp(`tailscale serve --bg http://127.0.0.1:${rport}`));
        // a forged local Host on the remote port, the remote Host on the local port, a wrong or missing login: refused
        assert.equal((await remote({ host: `localhost:${rport}` })).status, 403);
        assert.equal((await call(rs.port, { host: rhost })).status, 403);
        assert.equal((await remote({ headers: { 'tailscale-user-login': 'evil@x.com' } })).status, 403);
        assert.equal((await call(rport, { host: rhost })).status, 403);
        // unpaired: the pair page, without the token; everything else 401
        const pairHtml = await remote();
        assert.equal(pairHtml.status, 200);
        assert.match(pairHtml.body, /Pair this device/);
        assert.equal(meta(pairHtml.body), undefined);
        assert.equal(pairHtml.headers['cache-control'], 'no-store');
        for (const path of ['/app.js', '/sw.js', '/icon.svg', '/manifest.webmanifest', '/api/limits', '/api/pair/devices', '/api/push/key']) {
            assert.equal((await remote({ path })).status, 401, path);
        }
        // the Mac makes a code; a remote device can't
        const local = meta((await call(rs.port)).body);
        const { code } = JSON.parse((await call(rs.port, { path: '/api/pair/code', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': local } })).body);
        const form = c => ({ path: '/pair', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `https://${rhost}` }, body: `code=${c}&name=Phone` });
        assert.equal((await remote({ ...form(code), headers: { ...form(code).headers, origin: 'https://evil.com' } })).status, 403);
        const bad = await remote(form(code === '000000' ? '000001' : '000000'));
        assert.equal(bad.status, 401);
        assert.match(bad.body, /wrong or has expired/);
        const ok = await remote(form(code));
        assert.equal(ok.status, 303);
        const cookie = ok.headers['set-cookie'][0].split(';')[0];
        assert.match(ok.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
        assert.equal((await remote(form(code))).status, 401, 'single use');
        // paired: the app with its token; the API needs the token too; pairing stays Mac-only
        const app = await remote({ headers: { cookie } });
        const token = meta(app.body);
        assert.ok(token);
        assert.equal(token, local);
        assert.equal((await remote({ path: '/api/limits', headers: { cookie } })).status, 401);
        assert.equal((await remote({ path: '/api/limits', headers: { cookie, 'x-homebase-token': token } })).status, 200);
        assert.equal((await remote({ path: '/api/pair/devices', headers: { cookie, 'x-homebase-token': token } })).status, 403);
        // what a paired phone needs for push: the service worker, the icon, and the subscribe route
        const sw = await remote({ path: '/sw.js', headers: { cookie } });
        assert.deepEqual([sw.status, sw.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
        for (const path of ['/icon.svg', '/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png']) {
            assert.equal((await remote({ path, headers: { cookie } })).status, 200, path);
        }
        const subscribe = { path: '/api/push/unsubscribe', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token, origin: `https://${rhost}`, 'content-type': 'application/json' }, body: '{"endpoint":"https://fcm.googleapis.com/x"}' };
        assert.equal((await remote(subscribe)).status, 401, 'unpaired');
        assert.equal((await remote({ ...subscribe, headers: { ...subscribe.headers, cookie } })).status, 200);
        const ua = (await import('node:crypto')).createECDH('prime256v1');
        ua.generateKeys();
        const pushSub = { endpoint: 'https://fcm.googleapis.com/fcm/send/phone', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
        assert.equal((await remote({ ...subscribe, path: '/api/push/subscribe', headers: { ...subscribe.headers, cookie }, body: JSON.stringify(pushSub) })).status, 200);
        const subsFile = join(rs.dir, 'subscriptions.json');
        assert.equal(JSON.parse(readFileSync(subsFile, 'utf8')).length, 1);
        assert.equal((await remote({ path: '/api/server/reload', method: 'POST', headers: { cookie, 'x-homebase-token': token, 'x-codetool': '1' } })).status, 403, 'a phone cannot reload the server');
        // revoke on the Mac: the device is back to the pair page
        const [dev] = JSON.parse((await call(rs.port, { path: '/api/pair/devices', headers: { 'x-homebase-token': local } })).body);
        assert.equal(dev.name, 'Phone');
        assert.equal((await call(rs.port, { path: `/api/pair/revoke?id=${dev.id}`, method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': local } })).status, 200);
        assert.equal(meta((await remote({ headers: { cookie } })).body), undefined);
        assert.deepEqual(JSON.parse(readFileSync(subsFile, 'utf8')), [], 'revoke drops the device\'s push subscriptions');
    } finally { rs.stop(); }
    console.log('ok remote access');

    // Reload: POST /api/server/reload replaces the server with a fresh process on the same port.
{
    const s = await start({});
    let pid;
    try {
        const token = meta((await call(s.port)).body);
        const v = JSON.parse((await call(s.port, { path: '/api/version', headers: { 'x-homebase-token': token } })).body);
        assert.equal(v.serverStale, false);
        assert.match(v.page, /^[\w-]{12}$/);
        assert.equal((await call(s.port, { path: '/api/server/reload', method: 'POST', headers: { 'x-homebase-token': token } })).status, 404, 'needs x-codetool');
        assert.equal((await call(s.port, { path: '/api/server/reload', method: 'POST', headers: { 'x-codetool': '1', 'x-homebase-token': token } })).body, 'ok');
        for (let i = 0; !pid && i < 50; i++) {
            await new Promise(r => setTimeout(r, 200));
            const page = await call(s.port).catch(() => null);
            const fresh = page?.status === 200 && meta(page.body);
            if (fresh && fresh !== token) {
                pid = JSON.parse((await call(s.port, { path: '/api/version', headers: { 'x-homebase-token': fresh } })).body).pid;
            }
        }
        assert.ok(pid && pid !== v.pid, 'a new server answers on the same port');
        assert.match(readFileSync(join(s.dir, 'server.log'), 'utf8'), /Homebase on/);
    } finally {
        if (pid) {
            process.kill(pid);
        }
        s.stop();
    }
    console.log('ok server reload');
}
}

{
    // at most 2 run at once, in call order, and a rejection doesn't stall the queue
    const slot = limiter(2), started = [];
    let active = 0, peak = 0;
    const job = (n, fail) => slot(async () => {
        started.push(n); peak = Math.max(peak, ++active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        if (fail) {
            throw new Error(`job ${n}`);
        }
        return n;
    });
    const results = await Promise.allSettled([job(1), job(2, true), job(3), job(4), job(5)]);
    assert.equal(peak, 2);
    assert.deepEqual(started, [1, 2, 3, 4, 5]);
    assert.deepEqual(results.map(r => r.value ?? r.reason.message), [1, 'job 2', 3, 4, 5]);

    // concurrent calls for one key share a single run; after it settles the next call runs again
    const once = dedupe();
    let runs = 0;
    const call = k => once(k, async () => { runs++; await new Promise(r => setTimeout(r, 5)); return k; });
    assert.deepEqual(await Promise.all([call('a'), call('a'), call('b')]), ['a', 'a', 'b']);
    assert.equal(runs, 2);
    await call('a');
    assert.equal(runs, 3);
    await assert.rejects(once('x', () => { throw new Error('sync'); }), /sync/); // a throwing fn rejects, it doesn't throw
    assert.equal(await once('x', () => 'again'), 'again'); // and doesn't stick
    console.log('ok limiter dedupe');
}
