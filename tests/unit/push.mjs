import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { itemUpdated, isStale, serverMtime, pageHash } from '../../server.mjs';
import { runOutIn } from '../../web/src/lib/limits.ts';
import { chatMessage } from '../../web/src/lib/issues.ts';
import { reviewNote } from '../../web/src/lib/board.ts';
import { rulesStale, reloadMessage } from '../../server/rules.mjs';
import { RULES_FILE, rulesSources } from '../../server/tmux.mjs';
import { encrypt, vapidKeys, vapidJwt, pushTo, validSub, readSubs, addSub, removeSub, removeDeviceSubs, pushEvents, watchSessions, pageFocused } from '../../server/push.mjs';
import { codeDir } from './helpers.mjs';

// item age: forge-seeded MRs (no agent, no link time) take the MR's own update; nothing known stays 0
assert.equal(itemUpdated(null, 0, { updatedAt: 5000 }), 5000);
assert.equal(itemUpdated({ updated: 9000 }, 100, { updatedAt: 5000 }), 9000);
assert.equal(itemUpdated(null, 0, null), 0);
// limits pace: 10% in 10 minutes -> 90% left lasts 90 minutes, if that is before the reset
{
    const t = 1_000_000_000, m = 60_000;
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 50]], t + 10 * m + 120 * m, t + 10 * m), 50);
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 50]], t + 10 * m + 30 * m, t + 10 * m), null); // resets first
    assert.equal(runOutIn([[t, 40], [t + 10 * m, 40]], t + 500 * m, t + 10 * m), null); // flat
    assert.equal(runOutIn([[t, 40], [t + m, 45]], t + 500 * m, t + m), null); // too short to trust
    assert.equal(runOutIn([[t, 40]], t + 500 * m, t), null);
}

assert.equal(chatMessage({ iid: 9, st: 'closable', mrs: [{ iid: 30, state: 'merged' }] }), 'Close #9, its MR !30 is merged');
assert.equal(reviewNote([{ next: 'Waiting for review by Ann' }, { next: 'Waiting for review by Ann' }]), 'all waiting on Ann');
assert.equal(reviewNote([{ next: 'Waiting for review by Ann' }, { next: 'Needs a reviewer' }]), '');
assert.equal(reviewNote([]), '');

{
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const home = join(dir, 'home'), cwd = join(dir, 'proj');
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(cwd);
    const touch = (p, ms) => { writeFileSync(p, 'x'); utimesSync(p, ms / 1000, ms / 1000); };
    touch(join(home, '.claude', 'CLAUDE.md'), 1_000_000);
    touch(join(cwd, 'CLAUDE.md'), 2_000_000);
    const stale = (started, now) => rulesStale(started, cwd, now, home);
    assert.equal(await stale(Date.now(), 1e12), undefined, 'newer process: fresh');
    assert.equal(await stale(undefined, 1e13), undefined, 'unknown start: nothing inferred');
    const r = await stale(1_500_000, 1e14); // past the 10s cache, so the files are re-read; the real homebase-rules.md is listed too
    assert.ok(r.names.includes('CLAUDE.md') && r.at >= 2_000_000);
    assert.ok(r.reload.startsWith('The rules changed. Re-read /') && r.reload.includes(`${rulesSources().at(-1).split("/").pop()}, ~/.claude/CLAUDE.md and ${join(cwd, 'CLAUDE.md')} now and follow them`), r.reload);
    assert.equal(reloadMessage(), `The rules changed. Re-read ${[...rulesSources(), '~/.claude/CLAUDE.md'].join(' and ').replace(/ and (?=.* and )/g, ', ')} now and follow them from here on (they override your earlier instructions where they differ).`);
    assert.equal(reloadMessage(rulesSources()), reloadMessage(), 'a rules file inside the project (codetool itself) is named once');
    touch(join(cwd, 'AGENTS.md'), 5_000_000);
    assert.ok(!(await stale(1_500_000, 1e14 + 1000)).names.includes('AGENTS.md'), 'mtimes are cached for 10s');
    assert.ok((await stale(1_500_000, 1e14 + 20_000)).names.includes('AGENTS.md'));
    // token-saver.md: a flip and a flip back is not stale; a net change is, until the chat loaded it
    const { syncSaver } = await import('../../server.mjs');
    const hb = join(dir, 'hb'), was = process.env.HOMEBASE_DIR;
    process.env.HOMEBASE_DIR = hb;
    const lim = used => ({ fiveHour: { used }, sevenDay: { used: 0 } });
    const wait = () => new Promise(r => setTimeout(r, 15));
    await syncSaver(lim(0), hb);
    await wait();
    const started = Date.now();
    await wait();
    const sav = seenAt => rulesStale(started, cwd, 2e14 + Math.random() * 1e9, home, seenAt).then(r => r?.names.includes('token-saver.md'));
    await syncSaver(lim(90), hb);
    await wait();
    assert.equal(await sav(0), true, 'saver now on, chat started off');
    await syncSaver(lim(10), hb);
    assert.ok(!(await sav(0)), 'flipped back: same content as at start');
    await syncSaver(lim(90), hb);
    assert.equal(await sav(0), true);
    assert.ok(!(await sav(Date.now())), 'loaded on: nothing new');
    process.env.HOMEBASE_DIR = was;
    rmSync(dir, { recursive: true });
    const { saveSeen, readSeen } = await import('../../server.mjs');
    const sd = join(dir, 'seen');
    assert.deepEqual(await readSeen(sd), {}, 'nothing seen yet');
    await saveSeen('{"id":"a","at":5}', sd);
    await saveSeen('{"id":"a","at":3}', sd);
    assert.deepEqual(await readSeen(sd), { a: 5 }, 'kept on the server, never goes back');
    for (const bad of ['nope', '{}', '{"id":"","at":1}', '{"id":"a","at":"x"}']) {
        await assert.rejects(saveSeen(bad, sd), e => e.status === 400, bad);
    }
    console.log('ok rules stale');
}

{
    // RFC 8291 section 5 test vector
    const out = encrypt('When I grow up, I want to be a watermelon', { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') });
    assert.equal(out.toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
    console.log('ok push RFC 8291 vector');
}
{
    // VAPID: keys made once (0600, same on a second call), JWT is ES256 over header.payload with the push service's origin as aud
    const { createPublicKey, verify, createECDH } = await import('node:crypto');
    const dir = mkdtempSync(join(tmpdir(), 'hb-push-'));
    const keys = await vapidKeys(dir);
    assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'vapid.json'), 'utf8')), keys);
    assert.equal(Buffer.from(keys.publicKey, 'base64url').length, 65);
    const jwt = vapidJwt('https://web.push.apple.com', keys, 1_000_000_000);
    const [h, p, sig] = jwt.split('.');
    assert.deepEqual(JSON.parse(String(Buffer.from(h, 'base64url'))), { typ: 'JWT', alg: 'ES256' });
    assert.deepEqual(JSON.parse(String(Buffer.from(p, 'base64url'))), { aud: 'https://web.push.apple.com', exp: 1_000_000 + 43200, sub: 'mailto:homebase@example.com' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
    assert.equal(Buffer.from(sig, 'base64url').length, 64);
    assert.ok(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
    assert.ok(!verify('sha256', Buffer.from(`${h}.${p}x`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

    // a push carries the headers and an encrypted body the subscriber can open
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } };
    let got;
    assert.equal(await pushTo(sub, { title: 't' }, keys, async (url, headers, body) => { got = { url, headers, body }; return 201; }), 201);
    assert.equal(got.url, sub.endpoint);
    assert.match(got.headers.authorization, new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`));
    assert.equal(JSON.parse(String(Buffer.from(got.headers.authorization.split('.')[1], 'base64url'))).aud, 'https://fcm.googleapis.com');
    assert.deepEqual([got.headers.ttl, got.headers.urgency, got.headers['content-encoding'], got.headers['content-length']], ['3600', 'high', 'aes128gcm', got.body.length]);
    assert.equal(got.body.readUInt32BE(16), 4096);
    assert.equal(got.body[20], 65);

    // the subscription store: validated, deduped by endpoint, 0600, removed on 404/410 from the push service
    assert.ok(validSub(sub));
    assert.ok(!validSub({ ...sub, endpoint: 'https://evil.example/push' }));
    assert.ok(!validSub({ ...sub, endpoint: 'https://fcm.googleapis.com.evil.example/x' }));
    assert.ok(!validSub({ ...sub, endpoint: 'http://fcm.googleapis.com/x' }));
    assert.ok(!validSub({ ...sub, keys: { ...sub.keys, auth: 'AAAA' } }));
    assert.ok(!validSub({ endpoint: sub.endpoint }));
    assert.ok(!validSub(null));
    await addSub(dir, sub);
    await addSub(dir, { ...sub, extra: 1 });
    const other = { ...sub, endpoint: 'https://web.push.apple.com/xyz' };
    await addSub(dir, other);
    assert.deepEqual(await readSubs(dir), [sub, other]);
    assert.equal(statSync(join(dir, 'subscriptions.json')).mode & 0o777, 0o600);
    await removeSub(dir, other.endpoint);
    assert.deepEqual(await readSubs(dir), [sub]);
    await addSub(dir, other, 'dev1');
    await removeDeviceSubs(dir, 'dev1');
    assert.deepEqual(await readSubs(dir), [sub], 'revoking a device drops its subscriptions');

    // the watcher: the first list only sets the baseline; a new transition pushes to every device unless a page was focused
    const s = (id, extra = {}) => ({ id, project: 'alpha', status: 'idle', asking: false, needsYou: false, ...extra });
    const sent = [];
    const post = async url => { sent.push(url); return url === other.endpoint ? 410 : 201; };
    await addSub(dir, other);
    await watchSessions(dir, [s('a', { asking: true, question: 'Which one?' })], 0, post);
    assert.equal(sent.length, 0);
    await watchSessions(dir, [s('a', { asking: true, question: 'Which one?' }), s('b', { needsYou: true, lastReply: 'Cookie scope?' })], 1000, post);
    assert.deepEqual(sent.sort(), [other.endpoint, sub.endpoint].sort());
    assert.deepEqual(await readSubs(dir), [sub], 'the 410 one is gone');
    pageFocused(2000);
    await watchSessions(dir, [s('a'), s('b'), s('c', { asking: true })], 3000, post);
    assert.equal(sent.length, 2, 'a focused page within the minute: no push');
    rmSync(dir, { recursive: true });
    console.log('ok push vapid, send, store, watcher');
}
{
    // transitions: into asking or needs-you, one per session per 30s, never from subagent transcripts or a working chat
    const s = (id, extra = {}) => ({ id, project: 'alpha', status: 'idle', asking: false, needsYou: false, ...extra });
    const sent = new Map();
    let r = pushEvents(null, [s('a', { asking: true })], sent, 0);
    assert.deepEqual(r.events, []);
    r = pushEvents(r.next, [s('a', { asking: true }), s('b', { needsYou: true, lastReply: 'Pick one' }), s('w', { needsYou: true, status: 'working' }), s('x', { asking: true, sidechain: true })], sent, 1000);
    assert.deepEqual(r.events, [{ title: 'alpha needs you', body: 'Pick one', tag: 'b', chat: 'b' }]);
    r = pushEvents(r.next, [s('a'), s('b')], sent, 2000);
    r = pushEvents(r.next, [s('a', { asking: true, question: 'Which?' }), s('b', { needsYou: true })], sent, 3000);
    assert.deepEqual(r.events.map(e => [e.chat, e.body]), [['a', 'Which?']], 'b again within 30s is debounced');
    r = pushEvents(r.next, [s('a', { asking: true }), s('b')], sent, 40_000);
    r = pushEvents(r.next, [s('a', { asking: true }), s('b', { needsYou: true })], sent, 41_000);
    assert.deepEqual(r.events.map(e => e.chat), ['b'], 'a still asking: no new push');
    console.log('ok push transitions');
}

{
    assert.equal(isStale(1000, 1000), false);
    assert.equal(isStale(1000, 1001), true);
    // touching a server or browser file moves serverMtime or pageHash; in a stand-in tree, as other runs and agents touch the real one
    const dir = codeDir(), old = process.env.HOMEBASE_CODE_DIR;
    process.env.HOMEBASE_CODE_DIR = dir;
    const bump = async (file, read) => {
        const before = await read();
        utimesSync(join(dir, file), new Date(), new Date(Date.now() + 60_000));
        return [before, await read()];
    };
    try {
        const [m0, m1] = await bump('server/rules.mjs', serverMtime);
        assert.ok(isStale(m0, m1), 'server code change is stale');
        const [h0, h1] = await bump('public/styles.css', pageHash);
        assert.notEqual(h0, h1, 'browser file change moves the page hash');
    } finally {
        if (old === undefined) {
            delete process.env.HOMEBASE_CODE_DIR;
        } else {
            process.env.HOMEBASE_CODE_DIR = old;
        }
        rmSync(dir, { recursive: true });
    }
    console.log('ok stale detection');
}
