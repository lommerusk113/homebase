import assert from 'node:assert/strict';
import { api, page, refreshToken } from '../../public/core.js';
import { saveDraft, restoreDraft } from '../../public/chat.js';

{
    // A stub server: /api/* wants the current token, / serves the page with the token and build it has now.
    const real = globalThis.fetch, calls = [], codetool = [];
    let current = 'new', serveToken = 'new', build = 'b2';
    globalThis.fetch = async (path, opts = {}) => {
        calls.push(path);
        codetool.push([path, opts.headers?.['x-codetool']]);
        await new Promise(r => setTimeout(r, 2));
        if (path === '/') {
            return new Response(`<meta name="homebase-token" content="${serveToken}"><meta name="homebase-build" content="${build}">`);
        }
        return new Response('ok', { status: opts.headers['x-homebase-token'] === current ? 200 : 401 });
    };
    const count = p => calls.filter(c => c === p).length;
    try {
        // three concurrent 401s share one token fetch, then each retries once with the new token
        Object.assign(page, { token: 'old', build: 'b1', updated: false });
        const rs = await Promise.all([api('/api/a'), api('/api/b'), api('/api/c', { method: 'POST' })]);
        assert.deepEqual(rs.map(r => r.status), [200, 200, 200]);
        assert.equal(count('/'), 1);
        assert.deepEqual([count('/api/a'), count('/api/b'), count('/api/c')], [2, 2, 2]);
        // the retried POST still carries x-codetool, the GETs never do
        assert.deepEqual(codetool.filter(([p]) => p.startsWith('/api/')).map(([p, h]) => `${p}:${h}`).sort(), ['/api/a:undefined', '/api/a:undefined', '/api/b:undefined', '/api/b:undefined', '/api/c:1', '/api/c:1']);
        assert.equal(page.token, 'new');
        assert.equal(page.updated, true, 'a different build id flags the update');
        // the new token works: no refresh
        calls.length = 0;
        assert.equal((await api('/api/a')).status, 200);
        assert.deepEqual(calls, ['/api/a']);
        // the refreshed token still fails: one refresh, one retry, then the 401 goes back to the caller (no loop)
        calls.length = 0; current = 'other'; serveToken = 'newer';
        assert.equal((await api('/api/a')).status, 401);
        assert.deepEqual(calls, ['/api/a', '/', '/api/a']);
        // a page without a token (server down, pairing page): no retry at all
        calls.length = 0; serveToken = '';
        assert.equal((await api('/api/a')).status, 401);
        assert.deepEqual(calls, ['/api/a', '/']);
        // same build: no update note
        Object.assign(page, { build: 'b2', updated: false });
        await refreshToken();
        assert.equal(page.updated, false);
    } finally { globalThis.fetch = real; }

    // draft round trip with the selection; per session; never overwrites typed text; empty text removes it
    const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
    const ta = (value = '', start = 0, end = 0) => ({ value, selectionStart: start, selectionEnd: end, setSelectionRange(s, e) { this.selectionStart = s; this.selectionEnd = e; } });
    saveDraft(storage, 's1', ta('hello world', 6, 11));
    const back = ta();
    assert.equal(await restoreDraft(storage, 's1', back), true);
    assert.deepEqual([back.value, back.selectionStart, back.selectionEnd], ['hello world', 6, 11]);
    assert.equal(await restoreDraft(storage, 's2', ta()), false);
    const typed = ta('new');
    assert.equal(await restoreDraft(storage, 's1', typed), false);
    assert.equal(typed.value, 'new');
    saveDraft(storage, 's1', ta(''));
    assert.equal(mem.has('draft:s1'), false);
    saveDraft(null, 's1', ta('x')); // no storage: no throw
    assert.equal(await restoreDraft(null, 's1', ta()), false);
    console.log('ok token refresh, draft');
}
