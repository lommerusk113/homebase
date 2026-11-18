import assert from 'node:assert/strict';

const NEW_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const byId = id => `document.getElementById('${id}')`;
const steps = page => page.ev(`[...document.querySelectorAll('#np-steps li')].map(li => li.className + ':' + li.textContent)`);

// The page's own fetch answers /api/projects/new, held until __release() so the in-flight list can be seen; nothing reaches the server.
const stubNew = (page, status, body) => page.ev(`(() => {
    const real = window.fetch;
    window.__posts = [];
    window.fetch = (u, o) => {
        if (!String(u).includes('/api/projects/new')) {
            return real(u, o);
        }
        window.__posts.push({ headers: o.headers, body: JSON.parse(o.body) });
        return new Promise(r => { window.__release = () => r(new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} })); });
    };
})()`);

const openDialog = async page => {
    await page.click('#manage');
    await page.waitFor(`${byId('dlg')}.open && document.querySelector('.d-new wa-button')`, { what: 'the projects dialog' });
    await page.click('.d-new wa-button');
    await page.waitFor(`${byId('new-dlg')}.open`, { what: 'the new project dialog' });
};
const typeName = async (page, text) => {
    await page.ev(`${byId('np-name')}.value = ''; ${byId('np-name')}.focus()`);
    await page.type(text);
    await page.waitFor(`${byId('np-name')}.value === ${JSON.stringify(text)}`, { what: 'the typed name' });
};
const ok = (sessionId, state = 'done') => ({
    ok: true, name: 'newrepo', repo: 'lommerusk113/newrepo', dir: '/x/newrepo', sessionId,
    steps: [['repo', 'Creating repo'], ['clone', 'Cloning'], ['chat', 'Starting chat']].map(([id, label]) => ({ id, label, state }))
});

export default {
    'the dialog validates the name live and shows what it will create': async ({ page, open }) => {
        await open();
        await openDialog(page);
        assert.equal(await page.ev(`${byId('np-go')}.disabled`), true, 'empty name');
        assert.equal(await page.ev(`${byId('np-private')}.checked`), true, 'private by default');
        await page.waitFor(`${byId('np-note')}.textContent.includes('github.com/lommerusk113/<name>')`, { what: 'the config-driven note' });
        for (const [text, hint] of [['.hidden', "Can't start with a dot"], ['a b', 'Use letters, digits, ".", "_" and "-"'], ['good-name_1.x', '']]) {
            await typeName(page, text);
            assert.equal(await page.ev(`${byId('np-name')}.hint`), hint, text);
            assert.equal(await page.ev(`${byId('np-go')}.disabled`), !!hint, text);
        }
        assert.equal(await page.ev(`${byId('np-note')}.textContent`), 'Creates github.com/lommerusk113/good-name_1.x, clones it to ~/IdeaProjects/Privat/good-name_1.x and starts a Claude chat there.');
        assert.deepEqual(page.posts.filter(p => p.url.includes('/projects/new')), [], 'nothing is sent while typing');
    },

    'Create shows the steps, then tracks and selects the project and binds its chat': async ({ page, open }) => {
        await open();
        await openDialog(page);
        await typeName(page, 'newrepo');
        await page.ev(`${byId('np-desc')}.value = 'Hello'`);
        await stubNew(page, 200, ok(NEW_ID));
        await page.click('#np-go');
        await page.waitFor(`window.__posts.length === 1`, { what: 'the POST' });
        assert.deepEqual(await page.ev(`window.__posts[0].body`), { name: 'newrepo', description: 'Hello', private: true });
        assert.equal(await page.ev(`window.__posts[0].headers['x-codetool']`), '1', 'same guard header as the other POSTs');
        assert.deepEqual(await steps(page), ['running:Creating repo', 'pending:Cloning', 'pending:Starting chat']);
        assert.equal(await page.ev(`${byId('np-go')}.disabled`), true, 'no double submit');
        await page.ev(`window.__release()`);
        await page.waitFor(`!${byId('new-dlg')}.open`, { what: 'the dialog to close' });
        assert.deepEqual(await page.ev(`JSON.parse(localStorage.getItem('tracked'))`), ['alpha', 'beta', 'gamma', 'newrepo']);
        assert.equal(await page.ev(`localStorage.getItem('project')`), 'newrepo');
        assert.equal(await page.ev(`${byId('project')}.value`), 'newrepo');
        assert.equal(await page.ev(`localStorage.getItem('chat:newrepo')`), NEW_ID);
    },

    'without a session id yet the chat says it is starting': async ({ page, open }) => {
        await open();
        await openDialog(page);
        await typeName(page, 'newrepo');
        await stubNew(page, 200, ok(null));
        await page.click('#np-go');
        await page.waitFor(`window.__release`, { what: 'the POST' });
        await page.ev(`window.__release()`);
        await page.waitFor(`document.querySelector('#feed .welcome')?.textContent === 'Chat starting…'`, { what: 'the starting note' });
        assert.equal(await page.ev(`${byId('project')}.value`), 'newrepo');
    },

    'a failed step shows the error and the steps, and leaves the board alone': async ({ page, open }) => {
        await open();
        await openDialog(page);
        await typeName(page, 'newrepo');
        const error = 'HTTP 403: Resource not accessible by personal access token';
        await stubNew(page, 502, {
            ok: false, error,
            steps: [{ id: 'repo', label: 'Creating repo', state: 'failed', error }, { id: 'clone', label: 'Cloning', state: 'pending' }, { id: 'chat', label: 'Starting chat', state: 'pending' }]
        });
        await page.click('#np-go');
        await page.waitFor(`window.__release`, { what: 'the POST' });
        await page.ev(`window.__release()`);
        await page.waitFor(`${byId('np-err')}.textContent`, { what: 'the error' });
        assert.equal(await page.ev(`${byId('np-err')}.textContent`), error);
        assert.deepEqual(await steps(page), ['failed:Creating repo', 'pending:Cloning', 'pending:Starting chat']);
        assert.equal(await page.ev(`${byId('new-dlg')}.open`), true, 'stays open');
        assert.equal(await page.ev(`${byId('np-go')}.disabled`), false, 'can try again');
        assert.deepEqual(await page.ev(`JSON.parse(localStorage.getItem('tracked'))`), ['alpha', 'beta', 'gamma']);
        assert.equal(await page.ev(`localStorage.getItem('project')`), 'alpha');
    },

    'From my GitHub lists repos, filters, disables local ones, and picking one clones it like a new project': async ({ page, open }) => {
        await open();
        await openDialog(page);
        const repos = [
            { name: 'fresh', description: 'A fresh one', isPrivate: true, updatedAt: new Date(Date.now() - 3 * 86400_000).toISOString(), local: false },
            { name: 'have', description: '', isPrivate: false, updatedAt: new Date().toISOString(), local: true }
        ];
        await page.ev(`(() => {
            const real = window.fetch;
            window.__posts = [];
            window.fetch = (u, o) => {
                if (String(u).includes('/api/projects/github')) {
                    return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(repos))}));
                }
                if (String(u).includes('/api/projects/clone')) {
                    window.__posts.push(JSON.parse(o.body));
                    return Promise.resolve(new Response(${JSON.stringify(JSON.stringify({ ...ok(NEW_ID), name: 'fresh', repo: 'lommerusk113/fresh', steps: ok(NEW_ID).steps.slice(1) }))}));
                }
                return real(u, o);
            };
        })()`);
        await page.click('#np-tab-gh');
        await page.waitFor(`document.querySelectorAll('.np-repo').length === 2`, { what: 'the repo list' });
        assert.deepEqual(await page.ev(`[...document.querySelectorAll('.np-repo')].map(b => b.dataset.repo + '|' + b.disabled + '|' + b.textContent)`),
            ['fresh|false|fresh · privateA fresh one · updated 3d ago', 'have|true|havealready cloned']);
        assert.equal(await page.ev(`${byId('np-go')}.hidden`), true, 'picking is the action');
        await page.ev(`${byId('np-filter')}.value = 'FRE'; ${byId('np-filter')}.dispatchEvent(new Event('input'))`);
        assert.equal(await page.ev(`document.querySelectorAll('.np-repo').length`), 1, 'filtered');
        await page.ev(`document.querySelector('.np-repo[data-repo=have]')?.click()`);
        assert.equal(await page.ev(`window.__posts.length`), 0, 'a local repo is not clickable');
        await page.click('.np-repo[data-repo=fresh]');
        await page.waitFor(`!${byId('new-dlg')}.open`, { what: 'the dialog to close' });
        assert.deepEqual(await page.ev(`window.__posts`), [{ name: 'fresh' }]);
        assert.deepEqual(await page.ev(`JSON.parse(localStorage.getItem('tracked'))`), ['alpha', 'beta', 'gamma', 'fresh']);
        assert.equal(await page.ev(`localStorage.getItem('project')`), 'fresh');
        assert.equal(await page.ev(`localStorage.getItem('chat:fresh')`), NEW_ID);
    }
};
