// Dashboard over Claude Code transcripts in ~/.claude/projects. Only types into its own tmux sessions.
// Entry point: config, startup and the router. Everything else lives in server/ (see server/README.md); what test.mjs uses is re-exported here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { transcript } from './server/transcripts.mjs';
import { sessions, startingChats } from './server/sessions.mjs';
import { refreshAll, refreshInfo } from './server/forge.mjs';
import { milestones, warmMilestones } from './server/milestones.mjs';
import { reviewRequests } from './server/reviews.mjs';
import { limits } from './server/limits.mjs';
import { log } from './server/log.mjs';
import { MAX_SEND, withLock } from './server/tmux.mjs';
import { createProject, cloneProject, openProject, githubProjects, localProjects, publicConfig } from './server/newproject.mjs';
import { startupDialog, answerStartup, paneQuestion, answerQuestion, cancelQuestion } from './server/startup.mjs';
import { send, runningTwice, keepModelSetting, sendToNew, interrupt, clearChat, compactChat, restartChat, editors, openInEditor } from './server/control.mjs';
import { localHosts, allowedHost, allowedOrigin, tokenOk } from './server/security.mjs';
import { remoteFrom, setupPairing, isRemote, remoteHosts, loginOk, isPairedRequest, pair, deviceOf, cookieOf, deviceCookie, pairPage, newCode, pairedDevices, revoke } from './server/pairing.mjs';
import { readConfigFile } from './server/account.mjs';
import { STATIC, BUILD, CSP, vendorPath, sendRevalidated, serveVendor } from './server/static.mjs';
import { saveUpload, readUpload } from './server/uploads.mjs';
import { saveSeen } from './server/rules.mjs';
import { readTracked, saveTracked } from './server/tracked.mjs';
import { version, replaceSelf, listenRetry } from './server/reload.mjs';
import { vapidKeys, validSub, addSub, removeSub, removeDeviceSubs, readSubs, watchSessions, watchedAt, pageFocused } from './server/push.mjs';

export {
    readTail, filesTouched, splitTopic, splitTldr, gateRuns, toolSummary, unwrapPasted, chatItems, chatFeed, quickReplies, askList, optionLabels, waitingOn, waitingAsk, namedChoices,
    RISKY, pendingAsk, pendingQuestion, askMarker, markerAsk, turnState, turnPrompts, spawnPrompts, latestTopic, queuedPrompts, addUsage, readUsage, formatDuration, formatTokens
} from './server/transcripts.mjs';
export { repoName, repoPath, agentStage, agentStatus, summarizeAgent, stepOf, status, lastActivity, summarize, folderFor, sentSummaries } from './server/sessions.mjs';
export { pipelineOf, ciOf, issueOf, mentionsMr, limiter, dedupe, refetch, refreshDue, excerpt, withThreads, isBot, humanComments, fetchComments, signedIn, me, repoOfUrl, swrEntry, swr, cached, refreshAll, refreshInfo } from './server/forge.mjs';
export {
    column, gateFor, toGate, itemColumn, nextStep, rowAction, sameRepo, worksOnMr, requestFor, workItems, milestoneOf, itemUpdated
} from './server/items.mjs';
export { reviewRows } from './server/reviews.mjs';
export { keepMilestone, worksOn, groupIssues, activeMilestones, noMilestones, mineView } from './server/milestones.mjs';
export { limitsOf, peakLimits, contextOf } from './server/limits.mjs';
export { parseLog, branchOf, markPushed, chatMilestones, nestCommits, groupByDay } from './server/log.mjs';
export { tmuxArgs, tmuxFor, withLock, findClearedSuccessor, linkClears, NEW_TMUX, mapNewProjects, startingProjects, sendSteps, refuseIfLiveElsewhere } from './server/tmux.mjs';
export { parseDialog, parseQuestion, answerQuestion, cancelQuestion, questionOpen, selectSteps, answerStartup, trustFolder, trustNewProject } from './server/startup.mjs';
export { editorsFrom, openInEditor, refuseIfBusy, restartChat, promptUp, send, runningTwice, interrupt } from './server/control.mjs';
export { localHosts, allowedHost, allowedOrigin, tokenOk } from './server/security.mjs';
export { remoteFrom, setupPairing, newCode, pair, deviceOf, cookieOf, deviceCookie, pairedDevices, revoke, isRemote, loginOk, isPairedRequest, pairPage, CODE_TTL_MS, MAX_FAILS, FAIL_WINDOW_MS } from './server/pairing.mjs';
export { validName, mergeConfig, loadConfig, createProject, cloneProject, openProject, allowedDir, githubProjects, localProjects, DEFAULTS as NEW_PROJECT_DEFAULTS } from './server/newproject.mjs';
export { vendorPath } from './server/static.mjs';
export { accountOf, readToken, ghRun, scrub } from './server/account.mjs';
export { saveUpload, readUpload, UPLOAD_MAX, UPLOAD_NAME } from './server/uploads.mjs';
export { saveSeen, readSeen } from './server/rules.mjs';
export { readTracked, saveTracked, validTracked } from './server/tracked.mjs';
export { isStale, serverMtime, pageHash } from './server/reload.mjs';

const PORT = Number(process.env.PORT ?? 4321);

async function readBody(req, max) {

    let data = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
        data += chunk;
        if (data.length > max) {
            throw new Error('message too long');
        }
    }

    return data;
}

const DATA_DIR = process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const TOKEN = randomBytes(32).toString('hex');
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.env.HOMEBASE_LAN) {
        throw new Error('HOMEBASE_LAN is gone: use Homebase from another device through Tailscale and pairing (README, "Use from your phone")');
    }
    const REMOTE = remoteFrom(readConfigFile(), PORT);
    setupPairing(join(DATA_DIR, 'devices.json'), REMOTE);
    editors();
    warmMilestones();
    const handler = async (req, res) => {
        const url = new URL(req.url, 'http://x');
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
            res.setHeader(k, v);
        }
        const deny = (code, msg) => {
            res.statusCode = code;
            res.end(msg);
        };
        const json = value => {
            res.setHeader('content-type', 'application/json');
            return res.end(JSON.stringify(value));
        };
        // POST + custom header: a cross-origin page can't send this without a preflight we never answer
        const isPost = path => url.pathname === path && req.method === 'POST' && req.headers['x-codetool'] === '1';
        // Both listeners are on 127.0.0.1; the remote one is reached only through tailscale serve (server/pairing.mjs).
        const remote = isRemote(req);
        const hosts = remote ? remoteHosts() : localHosts(PORT);
        if (!allowedHost(req.headers.host, hosts) || !allowedOrigin(req.headers.origin, hosts, remote ? ['https', 'http'] : ['http'])) {
            return deny(403, 'forbidden');
        }
        const site = req.headers['sec-fetch-site'];
        if (req.method === 'POST' && site !== undefined && site !== 'same-origin') {
            return deny(403, 'forbidden');
        }
        if (remote && !loginOk(req)) {
            return deny(403, 'forbidden');
        }
        // An unpaired remote device gets the pair page and the pair form's POST, nothing else.
        if (!isPairedRequest(req)) {
            const pairHtml = (code, message) => {
                res.statusCode = code;
                res.setHeader('content-type', 'text/html; charset=utf-8');
                res.setHeader('content-security-policy', CSP);
                res.setHeader('cache-control', 'no-store');
                res.setHeader('referrer-policy', 'same-origin'); // under no-referrer the form's POST would carry Origin: null
                return res.end(pairPage(message));
            };
            if (url.pathname === '/pair' && req.method === 'POST') {
                try {
                    const form = new URLSearchParams(await readBody(req, 1024));
                    res.setHeader('set-cookie', deviceCookie(pair(form.get('code'), form.get('name'))));
                    res.statusCode = 303;
                    res.setHeader('location', '/');
                    return res.end();
                } catch (e) {
                    return pairHtml(e.status ?? 400, e.message);
                }
            }
            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
                return pairHtml(200);
            }
            return deny(401, 'pair this device first');
        }
        if (url.pathname.startsWith('/api/') && !tokenOk(req.headers['x-homebase-token'], TOKEN)) {
            return deny(401, 'unauthorized');
        }
        try {
            const file = Object.hasOwn(STATIC, url.pathname) && STATIC[url.pathname]; // not __proto__ and friends
            if (file) {
                res.setHeader('content-type', file[1]);
                const body = await readFile(new URL(`./public/${file[0]}`, import.meta.url));
                if (file[0] !== 'index.html') {
                    return sendRevalidated(req, res, body);
                }
                // The token reaches only a page served to a request that passed the Host and Origin checks above.
                res.setHeader('content-security-policy', CSP);
                res.setHeader('cache-control', 'no-store');
                return res.end(String(body).replace('__HOMEBASE_TOKEN__', TOKEN).replace('__HOMEBASE_BUILD__', BUILD));
            }
            const vendored = vendorPath(url.pathname);
            if (vendored && await serveVendor(vendored, req, res)) {
                return;
            }
            // Pairing is managed on the Mac only, never by a remote device.
            if (url.pathname.startsWith('/api/pair/') && remote) {
                return deny(403, 'pair devices from the Mac');
            }
            if (isPost('/api/pair/code')) {
                return json(newCode());
            }
            if (url.pathname === '/api/pair/devices') {
                return json(pairedDevices());
            }
            if (isPost('/api/pair/revoke')) {
                const id = url.searchParams.get('id');
                if (!revoke(id)) {
                    return deny(404, 'no such device');
                }
                await removeDeviceSubs(DATA_DIR, id); // a revoked phone gets no more notifications either
                return res.end('ok');
            }
            if (url.pathname === '/api/sessions') {
                if (url.searchParams.has('focused')) {
                    pageFocused();
                }
                const list = await sessions();
                watchSessions(DATA_DIR, list).catch(e => console.error(`push: ${e.message}`));
                return json(list);
            }
            // The board's projects, shared by the Mac and its paired devices
            if (url.pathname === '/api/tracked' && req.method === 'GET') {
                return json(await readTracked(DATA_DIR));
            }
            if (isPost('/api/tracked')) {
                await saveTracked(DATA_DIR, await readBody(req, 64 * 1024));
                return res.end('ok');
            }
            if (isPost('/api/rules/seen')) {
                await saveSeen(await readBody(req, 4 * 1024));
                return res.end('ok');
            }
            if (url.pathname === '/api/version') {
                return json(await version());
            }
            // Local only: a paired phone can't restart the Mac's server.
            if (isPost('/api/server/reload')) {
                if (remote) {
                    return deny(403, 'reload the server from the Mac');
                }
                res.end('ok');
                return replaceSelf(listeners, PORT, join(DATA_DIR, 'server.log'));
            }
            if (url.pathname === '/api/push/key') {
                return json({ key: (await vapidKeys(DATA_DIR)).publicKey });
            }
            if (isPost('/api/push/subscribe') || isPost('/api/push/unsubscribe')) {
                // The gate above already turned unpaired remote devices away; checked again here so a change there can't open this.
                if (!isPairedRequest(req)) {
                    return deny(401, 'pair this device first');
                }
                let input;
                try {
                    input = JSON.parse(await readBody(req, 4096));
                } catch {
                    return deny(400, 'expected a JSON body');
                }
                if (url.pathname === '/api/push/unsubscribe') {
                    await removeSub(DATA_DIR, String(input?.endpoint));
                    return res.end('ok');
                }
                if (!validSub(input)) {
                    return deny(400, 'not a push subscription from a known push service');
                }
                await addSub(DATA_DIR, input, remote ? deviceOf(cookieOf(req.headers.cookie))?.id : undefined);
                return res.end('ok');
            }
            if (isPost('/api/send')) {
                const body = await readBody(req, MAX_SEND);
                if (url.searchParams.has('tmux')) {
                    await sendToNew(url.searchParams.get('tmux'), body); // a new project's chat that has no transcript yet
                } else {
                    const restore = /^\/model \w+$/.test(body.trim()) ? await keepModelSetting().catch(() => null) : null; // a pick is for this chat only
                    await send(url.searchParams.get('id'), body, null, { after: restore });
                    return res.end(await runningTwice(url.searchParams.get('id')) ?? 'ok'); // sent; the text is a warning
                }
                return res.end('ok');
            }
            if (isPost('/api/upload')) {
                res.setHeader('connection', 'close'); // a refused body is not read to the end
                return json({ path: await saveUpload(req, req.headers['content-type'], req.headers['content-length'], UPLOAD_DIR) });
            }
            if (url.pathname.startsWith('/api/upload/') && req.method === 'GET') {
                const img = await readUpload(url.pathname.slice('/api/upload/'.length), UPLOAD_DIR);
                if (!img) {
                    return deny(404, 'not found');
                }
                res.setHeader('content-type', img.type);
                res.setHeader('cache-control', 'private, max-age=31536000, immutable'); // a name is never reused
                return res.end(img.body);
            }
            if (url.pathname === '/api/starting') {
                return json(await startingChats());
            }
            if (url.pathname === '/api/startup' && req.method === 'GET') {
                return json({ dialog: await startupDialog(url.searchParams.get('tmux')) });
            }
            if (isPost('/api/startup')) {
                const t = url.searchParams.get('tmux');
                await withLock(t, () => answerStartup(t, Number(url.searchParams.get('option')), url.searchParams.get('label')));
                return res.end('ok');
            }
            if (url.pathname === '/api/question' && req.method === 'GET') {
                return json({ question: await paneQuestion(url.searchParams.get('tmux')) });
            }
            if (isPost('/api/question') && url.searchParams.has('dismiss')) {
                const t = url.searchParams.get('tmux');
                await withLock(t, () => cancelQuestion(t));
                return res.end('ok');
            }
            if (isPost('/api/question')) {
                const t = url.searchParams.get('tmux');
                await withLock(t, () => answerQuestion(t, Number(url.searchParams.get('option')), url.searchParams.get('label'), { seen: url.searchParams.get('seen') }));
                return res.end('ok');
            }
            if (isPost('/api/clear')) {
                await clearChat(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (isPost('/api/compact')) {
                await compactChat(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (isPost('/api/restart')) {
                await restartChat(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (isPost('/api/interrupt')) {
                await interrupt(url.searchParams.get('id'));
                return res.end('ok');
            }
            if (isPost('/api/open')) {
                await openInEditor(url.searchParams.get('item'), url.searchParams.get('editor'));
                return res.end('ok');
            }
            if (isPost('/api/projects/new') || isPost('/api/projects/clone') || isPost('/api/projects/open')) {
                let input;
                try {
                    input = JSON.parse(await readBody(req, 4096));
                } catch {
                    return deny(400, 'expected a JSON body');
                }
                return json(await ({ '/api/projects/new': createProject, '/api/projects/clone': cloneProject, '/api/projects/open': openProject })[url.pathname](input));
            }
            if (url.pathname === '/api/projects/github') {
                return json(await githubProjects());
            }
            if (url.pathname === '/api/projects/local') {
                return json(await localProjects());
            }
            if (url.pathname === '/api/projects/config') {
                return json(await publicConfig());
            }
            // GET: { refreshing, lastRefreshedAt }; POST refreshes first and answers once the refetch is done
            if (url.pathname === '/api/refresh' && (req.method === 'GET' || req.headers['x-codetool'] === '1')) {
                if (req.method === 'POST') {
                    await refreshAll();
                }
                return json(refreshInfo());
            }
            if (url.pathname === '/api/editors') {
                return json((await editors()).map(({ id, name }) => ({ id, name })));
            }
            if (url.pathname === '/api/reviews') {
                return json(reviewRequests());
            }
            if (url.pathname === '/api/milestones') {
                return json(await milestones(url.searchParams.get('project'), url.searchParams.get('milestone')));
            }
            if (url.pathname === '/api/log') {
                return json(await log(url.searchParams.get('project')));
            }
            if (url.pathname === '/api/limits') {
                return json(await limits());
            }
            if (url.pathname === '/api/transcript') {
                return json(await transcript(url.searchParams.get('dir'), url.searchParams.get('id'), url.searchParams.get('max')));
            }
            res.statusCode = 404;
            res.end('not found');
        } catch (e) {
            res.statusCode = e.status ?? 500;
            if (e.body) {
                return json(e.body);
            }
            res.end(String(e.message));
        }
    };
    const listeners = []; // [server, port], for replaceSelf
    const listen = (port, done) => {
        const server = createServer(handler);
        listeners.push([server, port]);
        listenRetry(server, port, done);
    };
    const listenLocal = () => listen(PORT, () => console.log(`Homebase on http://localhost:${PORT}`));
    if (REMOTE) { // the remote port first, so "Homebase on" means both listen
        listen(REMOTE.port, () => {
            console.log(`Remote access for https://${REMOTE.host} on 127.0.0.1:${REMOTE.port}; expose it with \`tailscale serve --bg http://127.0.0.1:${REMOTE.port}\``);
            listenLocal();
        });
    } else {
        listenLocal();
    }
    // With no page polling /api/sessions, the push watcher looks every 5s itself, and only while a device is subscribed.
    setInterval(async () => {
        if (Date.now() - watchedAt() < 5000 || !(await readSubs(DATA_DIR)).length) {
            return;
        }
        try {
            await watchSessions(DATA_DIR, await sessions());
        } catch (e) {
            console.error(`push: ${e.message}`);
        }
    }, 5000);
}
