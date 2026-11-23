// Unit tests: one file per area under tests/unit/, run one after another in this order.
// Each prints `ok <name>` per passing group; a failing assert rejects the import and fails the run.
const UNITS = [
    'agents', 'chat', 'items', 'comments', 'asks', 'usage', 'milestones', 'turns', 'board', 'security', 'http',
    'client', 'links', 'transcripts', 'projects', 'accounts', 'forge', 'sessions', 'send', 'questions', 'push',
    'diff', 'setup', 'forge-rows', 'robustness',
];

for (const unit of UNITS) {
    await import(`./tests/unit/${unit}.mjs`);
}

// The Vue islands (web/dist): served with their types behind the Host check, their tags in index.html only once built
{
    const dist = mkdtempSync(join(tmpdir(), 'hb-web-')), dir = mkdtempSync(join(tmpdir(), 'hb-web-home-'));
    const port = await new Promise(r => { const s = netServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
    const get = (path, host = `localhost:${port}`) => new Promise((ok, fail) => request({ host: '127.0.0.1', port, path, headers: { host } }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => ok({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', fail).end());
    const child = spawn(process.execPath, ['server.mjs'], { cwd: import.meta.dirname, env: { ...process.env, HOME: dir, PORT: String(port), HOMEBASE_DIR: dir, HOMEBASE_CODE_DIR: codeDir(join(dir, 'code')), HOMEBASE_STATUSLINE_DIR: dir, HOMEBASE_TMUX_SOCKET: 'homebase-test-none', HOMEBASE_WEB_DIST: dist }, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
        await new Promise((ok, fail) => { let out = ''; child.stdout.on('data', c => { out += c; if (out.includes('Homebase on')) ok(); }); child.on('exit', fail); });
        assert.doesNotMatch((await get('/')).body, /\/web\/main/, 'not built: the page loads no island files');
        assert.equal((await get('/web/main.js')).status, 404);
        writeFileSync(join(dist, 'main.js'), 'export const mount = () => {};');
        writeFileSync(join(dist, 'main.css'), '.hb-island {}');
        assert.match((await get('/')).body, /<link rel="stylesheet" href="\/web\/main.css">\n<script type="module" src="\/web\/main.js"><\/script>/, 'built: no restart needed');
        assert.deepEqual(await get('/web/main.js'), { status: 200, type: 'text/javascript; charset=utf-8', body: 'export const mount = () => {};' });
        assert.deepEqual(await get('/web/main.css'), { status: 200, type: 'text/css; charset=utf-8', body: '.hb-island {}' });
        assert.equal((await get('/web/main.js', 'evil.com')).status, 403, 'the Host check applies');
        assert.equal((await get('/web/other.js')).status, 404, 'only the fixed pair');
    } finally {
        child.kill();
        rmSync(dist, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
    }
    console.log('ok web islands served');
}
