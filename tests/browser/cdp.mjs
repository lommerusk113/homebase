// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. One page, every request intercepted:
// localhost goes through (or to `page.route`), anything else is failed and recorded, so nothing leaves the machine.
import { spawn } from 'node:child_process';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCAL = /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/|data:|blob:)/;

export function launchChrome(path, port, profile) {
    return spawn(path, [
        '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', 'about:blank'
    ], { stdio: 'ignore', detached: true }); // own process group, so cleanup can kill its helpers too
}

export async function connect(port) {

    let tabs;
    for (let i = 0; i < 100 && !tabs; i++) {
        try {
            tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        } catch {
            await sleep(100);
        }
    }
    if (!tabs) {
        throw new Error(`Chrome's debug port ${port} never answered`);
    }

    const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

    let seq = 0;
    const pending = new Map(), listeners = [];
    const page = {
        errors: [], // console errors, uncaught exceptions, error log entries
        requests: [], // every URL the page asked for
        external: [], // requests that would have left localhost (failed instead)
        posts: [], // { url, body } of every POST, answered by route or passed through
        navigations: 0, // main-frame navigations
        route: null, // (request) => { status, body, headers } to answer it here, { delay } to pass it on after delay ms, or null to pass it on

        cmd(method, params = {}) {
            return new Promise((ok, fail) => {
                pending.set(++seq, d => (d.error ? fail(new Error(`${method}: ${d.error.message}`)) : ok(d.result)));
                ws.send(JSON.stringify({ id: seq, method, params }));
            });
        },
        // returns a function that removes the listener
        on(method, fn) {
            const l = [method, fn];
            listeners.push(l);
            return () => listeners.splice(listeners.indexOf(l), 1);
        },
        async ev(expression) {
            const r = await page.cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) {
                throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n  ${expression.slice(0, 200)}`);
            }
            return r.result.value;
        },
        // Polls expression until it is truthy and returns its value; the error says what it waited for and what it last saw.
        async waitFor(expression, { timeout = 10_000, what = expression } = {}) {
            const end = Date.now() + timeout;
            let last;
            for (;;) {
                last = await page.ev(expression).catch(e => e.message);
                if (last && !(typeof last === 'string' && last.startsWith('in page:'))) {
                    return last;
                }
                if (Date.now() > end) {
                    throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
                }
                await sleep(100);
            }
        },
        async goto(url) {
            let off;
            const loaded = new Promise(r => { off = page.on('Page.loadEventFired', r); }).finally(() => off());
            await page.cmd('Page.navigate', { url });
            await loaded;
        },
        async key(key, code = key.length === 1 ? `Key${key.toUpperCase()}` : key) {
            const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
            const vk = { Enter: 13, Escape: 27 }[key] ?? key.toUpperCase().charCodeAt(0);
            await page.cmd('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text, windowsVirtualKeyCode: vk });
            await page.cmd('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
        },
        type: text => page.cmd('Input.insertText', { text }),
        // A real mouse click in the middle of the first element matching selector (scrolled into view first).
        click: selector => page.clickOn(`document.querySelector(${JSON.stringify(selector)})`, selector),
        // The same for the element a page expression returns.
        async clickOn(expression, what = expression) {
            const box = await page.ev(`(() => { const e = ${expression}; if (!e) return null;
                e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
            if (!box) {
                throw new Error(`nothing to click at ${what}`);
            }
            for (const type of ['mousePressed', 'mouseReleased']) {
                await page.cmd('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
            }
        },
        close: () => ws.close()
    };

    ws.onmessage = m => {
        const d = JSON.parse(m.data);
        if (d.id) {
            pending.get(d.id)?.(d);
            pending.delete(d.id);
            return;
        }
        const p = d.params;
        if (d.method === 'Fetch.requestPaused') {
            const q = p.request;
            page.requests.push(q.url);
            if (!LOCAL.test(q.url)) {
                page.external.push(q.url);
                return page.cmd('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
            }
            if (q.method === 'POST') {
                page.posts.push({ url: q.url, body: q.postData ?? '' });
            }
            const r = page.route?.(q);
            if (r?.delay) {
                return sleep(r.delay).then(() => page.cmd('Fetch.continueRequest', { requestId: p.requestId })).catch(() => {});
            }
            const answer = r
                ? page.cmd('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: r.status ?? 200, responseHeaders: Object.entries(r.headers ?? { 'content-type': 'text/plain' }).map(([name, value]) => ({ name, value })), body: Buffer.from(r.body ?? '').toString('base64') })
                : page.cmd('Fetch.continueRequest', { requestId: p.requestId });
            return answer.catch(() => {}); // the page may have navigated away meanwhile
        }
        if (d.method === 'Runtime.exceptionThrown') {
            page.errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text);
        } else if (d.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
            page.errors.push(p.args.map(a => a.value ?? a.description).join(' '));
        } else if (d.method === 'Log.entryAdded' && p.entry.level === 'error') {
            page.errors.push(`${p.entry.text} ${p.entry.url ?? ''}`.trim());
        } else if (d.method === 'Page.frameNavigated' && !p.frame.parentId) {
            page.navigations++;
        }
        for (const [method, fn] of [...listeners]) {
            if (method === d.method) {
                fn(p);
            }
        }
    };

    for (const domain of ['Runtime', 'Log', 'Page']) {
        await page.cmd(`${domain}.enable`);
    }
    await page.cmd('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    // CSP violations land in window.__csp, from the very first script on every load
    await page.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));` });
    await page.cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    return page;
}
