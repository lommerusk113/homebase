// Dashboard over Claude Code transcripts in ~/.claude/projects. Only types into its own tmux sessions.
// Entry point: config, startup and the router. Everything else lives in server/ (see server/README.md); what the unit tests (tests/unit/) use is re-exported here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { transcript, agentFeed } from './server/transcripts.mjs';
import { polledSessions, startingChats } from './server/sessions.mjs';
import { refreshAll, refreshInfo, isGitLab } from './server/forge.mjs';
import { milestones, warmMilestones } from './server/milestones.mjs';
import { reviewRequests } from './server/reviews.mjs';
import { limits } from './server/limits.mjs';
import { log } from './server/log.mjs';
import { MAX_SEND, withLock } from './server/tmux.mjs';
import { startIssue } from './server/start.mjs';
import { createProject, cloneProject, openProject, githubProjects, localProjects, publicConfig } from './server/newproject.mjs';
import { startupDialog, answerStartup, paneQuestion, answerQuestion, cancelQuestion, confirmModelSwitch } from './server/startup.mjs';
import { send, runningTwice, keepModelSetting, sendToNew, interrupt, clearChat, compactChat, restartChat, settleCommand } from './server/control.mjs';
import { localHosts, allowedHost, allowedOrigin, tokenOk, ownerOnly, errorReply } from './server/security.mjs';
import { remoteFrom, setupPairing, isRemote, remoteHosts, loginOk, isPairedRequest, pair, deviceOf, cookieOf, deviceCookie, pairPage, newCode, pairedDevices, revoke } from './server/pairing.mjs';
import { readConfigFile, repoPaths } from './server/account.mjs';
import { STATIC, BUILD, CSP, vendorPath, sendRevalidated, serveVendor, webTags, serveWeb } from './server/static.mjs';
import { saveUpload, readUpload } from './server/uploads.mjs';
import { saveSeen } from './server/rules.mjs';
import { readTracked, saveTracked } from './server/tracked.mjs';
import { saveSaver, syncSaver } from './server/saver.mjs';
import { readChecks, saveChecks } from './server/checks.mjs';
import { loadHandled, markHandled } from './server/handled.mjs';
import { loadDismissed, dismiss } from './server/dismissed.mjs';
import { loadReviewers, startReviewer, markFindingsSent } from './server/reviewer.mjs';
import { version, replaceSelf, listenRetry } from './server/reload.mjs';
import { vapidKeys, validSub, addSub, removeSub, removeDeviceSubs, readSubs, watchSessions, watchedAt, pageFocused } from './server/push.mjs';
import { diff } from './server/diff.mjs';
import { claim, release } from './server/once.mjs';
import { pushSession } from './server/gitpush.mjs';
import { doctor, setup, unsetup, missingTools, readClaudeVersion, versionWarning } from './server/setup.mjs';

export { readTail, filesTouched, unwrapPasted } from './server/entries.mjs';
export { splitTopic, splitTldr, gateRuns, toolSummary, RISKY, latestTopic, queuedPrompts } from './server/summaries.mjs';
export { chatItems, chatFeed } from './server/feed.mjs';
export { quickReplies, askList, optionLabels, waitingOn, waitingAsk, waitingQuestion, namedChoices } from './server/asks.mjs';
export { pendingAsk, pendingQuestion, askMarker, markerAsk, helperAsk, openToolUse, askingHelper, turnState, turnPrompts, spawnPrompts } from './server/turns.mjs';
export { addUsage, readUsage, formatDuration, formatTokens } from './server/usage.mjs';
export { repoName, repoPath, agentStage, agentStatus, summarizeAgent, stepOf, status, lastActivity, summarize, sentSummaries } from './server/sessions.mjs';
export { pipelineOf, ciOf, issueOf, mentionsMr, limiter, dedupe, refetch, refreshDue, excerpt, withThreads, isBot, humanComments, fetchComments, signedIn, me, repoOfUrl, swrEntry, swr, cached, refreshAll, refreshInfo } from './server/forge.mjs';
export {
    gateFor, toGate, rowOf, sameRepo, worksOnMr, requestFor, workItems, milestoneOf, itemUpdated
} from './server/items.mjs';
export { reviewRows } from './server/reviews.mjs';
export { keepMilestone, worksOn, groupIssues, activeMilestones, noMilestones, mineView } from './server/milestones.mjs';
export { limitsOf, peakLimits, contextOf } from './server/limits.mjs';
export { parseLog, branchOf, markPushed, chatMilestones, nestCommits, groupByDay } from './server/log.mjs';
export { tmuxArgs, tmuxFor, withLock, findClearedSuccessor, linkClears, NEW_TMUX, mapNewProjects, startingProjects, sendSteps, refuseIfLiveElsewhere } from './server/tmux.mjs';
export { parseDialog, parseQuestion, answerQuestion, cancelQuestion, questionOpen, selectSteps, answerStartup, trustFolder, trustNewProject } from './server/startup.mjs';
export { refuseIfBusy, restartChat, promptUp, send, runningTwice, interrupt } from './server/control.mjs';
export { localHosts, allowedHost, allowedOrigin, tokenOk } from './server/security.mjs';
export { remoteFrom, setupPairing, newCode, pair, deviceOf, cookieOf, deviceCookie, pairedDevices, revoke, isRemote, loginOk, isPairedRequest, pairPage, CODE_TTL_MS, MAX_FAILS, FAIL_WINDOW_MS } from './server/pairing.mjs';
export { validName, mergeConfig, loadConfig, createProject, cloneProject, openProject, allowedDir, githubProjects, localProjects, DEFAULTS as NEW_PROJECT_DEFAULTS } from './server/newproject.mjs';
export { validateStart, branchSlug, takenBy, startPrompt, startIssue, prepareWorktree, targetOf } from './server/start.mjs';
export { vendorPath } from './server/static.mjs';
export { accountOf, readToken, ghRun, scrub } from './server/account.mjs';
export { saveUpload, readUpload, UPLOAD_MAX, UPLOAD_NAME } from './server/uploads.mjs';
export { saveSeen, readSeen } from './server/rules.mjs';
export { readTracked, saveTracked, validTracked } from './server/tracked.mjs';
export { saverOn, saveSaver, syncSaver, saverRules, SAVER_RULE } from './server/saver.mjs';
export { isStale, serverMtime, pageHash } from './server/reload.mjs';
export { parseNumstat, parseNameStatus, parseStatus, changes, fileBody, diffFolder, diff, MAX_DIFF_BYTES } from './server/diff.mjs';

const PORT = Number(process.env.PORT ?? 4321);
const DEMO = !!process.env.HOMEBASE_DEMO; // set by scripts/demo.mjs for the server it starts on invented data

async function readBody(req, max) {

    let data = '';
    req.setEncoding('utf8');
    for await (const chunk of req) {
        data += chunk;
        if (data.length > max) {
            throw Object.assign(new Error('message too long'), { status: 413 });
        }
    }

    return data;
}

const DATA_DIR = process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
const UPLOAD_DIR = join(DATA_DIR, 'uploads');
const TOKEN = randomBytes(32).toString('hex');
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
if (import.meta.url === `file://${process.argv[1]}`) {
    if (process.argv.includes('--doctor')) {
        const { lines, failed } = doctor();
        console.log(lines.join('\n'));
        process.exit(failed ? 1 : 0);
    }
    if (process.argv.includes('--setup')) {
        console.log(await setup());
        process.exit(0);
    }
    if (process.argv.includes('--unsetup')) {
        console.log(await unsetup());
        process.exit(0);
    }
    if (process.argv.includes('--demo')) {
        await (await import('./scripts/demo.mjs')).runDemo();
    }
    const missing = DEMO ? [] : missingTools(); // the demo starts no chats
    if (missing.length) {
        console.warn(`Warning: ${missing.join(' and ')} not found on PATH, so Homebase cannot start chats (run: node server.mjs --doctor)`);
    }
    if (!DEMO && readClaudeVersion() && versionWarning()) {
        console.warn(`Warning: ${versionWarning()}`);
    }
    if (process.env.HOMEBASE_LAN) {
        throw new Error('HOMEBASE_LAN is gone: use Homebase from another device through Tailscale and pairing (README, "Use from your phone")');
    }
    const REMOTE = remoteFrom(readConfigFile(), PORT);
    setupPairing(join(DATA_DIR, 'devices.json'), REMOTE);
    ownerOnly(DATA_DIR);
    loadHandled(DATA_DIR);
    loadDismissed(DATA_DIR);
    loadReviewers(DATA_DIR);
    warmMilestones();
    const sentRows = new Map(); // rowKey -> { at, kind }: the row buttons' double-send guard (server/once.mjs)
    const kindOf = async key => (await polledSessions()).flatMap(s => s.items ?? []).find(i => i.key === key)?.state?.kind;
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
                // data-remote: a paired device, so the page leaves out what only the Mac can do (pairing).
                res.setHeader('content-security-policy', CSP);
                res.setHeader('cache-control', 'no-store');
                return res.end(String(body).replace('__HOMEBASE_TOKEN__', TOKEN).replace('__HOMEBASE_BUILD__', BUILD).replace('data-demo hidden', DEMO ? 'data-demo' : 'data-demo hidden').replace('<html ', remote ? '<html data-remote ' : '<html ').replace('<!-- homebase-web -->', webTags()));
            }
            if (await serveWeb(url.pathname, req, res)) {
                return;
            }
            const vendored = vendorPath(url.pathname);
            if (vendored && await serveVendor(vendored, req, res)) {
                return;
            }
            // The demo types nothing anywhere; a 409's text is what the chat shows under the unsent message or answer.
            if (DEMO && req.method === 'POST' && /^\/api\/(send|startup|question|handled|dismissed|clear|compact|restart|interrupt|projects\/|server\/reload)/.test(url.pathname)) {
                throw Object.assign(new Error('This is the demo: nothing is sent to Claude'), { status: 409 });
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
                const list = await polledSessions();
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
            // Token saver: helpers on Sonnet (server/saver.mjs)
            if (url.pathname === '/api/saver' && req.method === 'GET') {
                return json(await syncSaver(await limits(), DATA_DIR));
            }
            if (isPost('/api/saver')) {
                return json(await saveSaver(await readBody(req, 1024), DATA_DIR, await limits()));
            }
            // Check commands the Stop hook runs before a chat may finish (server/checks.mjs); set with POST {commands: [...]}
            if (url.pathname === '/api/checks' && req.method === 'GET') {
                return json({ commands: readChecks(url.searchParams.get('project'), DATA_DIR) });
            }
            if (isPost('/api/checks')) {
                if (remote) {
                    return deny(403, 'set check commands from the Mac'); // they run as shell commands: a paired phone must not set them
                }
                return json(saveChecks(url.searchParams.get('project'), await readBody(req, 16 * 1024), DATA_DIR));
            }
            // A reply that wrongly says "needs you", marked as handled; an open question or permission prompt is not one
            if (isPost('/api/handled')) {
                await markHandled(DATA_DIR, url.searchParams.get('id'), url.searchParams.get('reply'));
                return res.end('ok');
            }
            // A row without an MR (a stopped or finished helper) the user is done with: hidden until that helper moves again
            if (isPost('/api/dismissed')) {
                await dismiss(DATA_DIR, url.searchParams.get('key'));
                polledSessions.stale();
                return res.end('ok');
            }
            // Review chat of an "In review" row: the row is looked up here, so only a row the board shows can be reviewed, in its own checkout
            if (isPost('/api/reviewer') || isPost('/api/reviewer/sent')) {
                const list = await polledSessions();
                const key = url.searchParams.get('key');
                const row = list.flatMap(s => s.items ?? []).find(i => i.key === key);
                if (!row) {
                    return deny(404, 'no such row');
                }
                if (url.pathname.endsWith('/sent')) {
                    await markFindingsSent(DATA_DIR, key);
                } else {
                    if (row.column !== 'review') {
                        return deny(409, 'only a row in review can be reviewed');
                    }
                    const cwd = row.worktreePath ?? list.find(s => s.id === row.sessionId)?.cwd;
                    if (!cwd || !existsSync(cwd)) {
                        return deny(409, 'the row has no checkout to review');
                    }
                    const repo = repoPaths.get(row.project);
                    const once = url.searchParams.get('once');
                    if (once && !claim(sentRows, once, row.state?.kind)) {
                        res.setHeader('x-homebase-once', '1');
                        return deny(409, 'Already sent');
                    }
                    try {
                        await startReviewer(DATA_DIR, { key, cwd, gitlab: !!repo && isGitLab(repo), sha: row.prState?.sha });
                    } catch (e) {
                        if (once) {
                            release(sentRows, once);
                        }
                        throw e;
                    }
                }
                polledSessions.stale();
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
                // a row button's send: a repeat of the same row at the same state kind is refused (a second click, a second device)
                const once = url.searchParams.get('once');
                if (once && !claim(sentRows, once, await kindOf(once))) {
                    res.setHeader('x-homebase-once', '1'); // the client's quiet "Already sent", not an error
                    return deny(409, 'Already sent');
                }
                try {
                if (url.searchParams.has('tmux')) {
                    await sendToNew(url.searchParams.get('tmux'), body); // a new project's chat that has no transcript yet
                } else {
                    const pick = /^\/model \w+$/.test(body.trim());
                    const restore = pick ? await keepModelSetting().catch(() => null) : null; // a pick is for this chat only
                    // a pick also confirms Claude's "Switch model?"; a plain send never answers anything. A slash command's
                    // panel is read and closed (settleCommand), and comes back as JSON for the chat to show
                    const slash = body.trim().startsWith('/');
                    let result = null, said = 'ok';
                    await send(url.searchParams.get('id'), body, null, {
                        answered: () => { said = 'answered'; }, // typed into the open question's text box
                        typed: !url.searchParams.has('canned'), // a button's message never declines an open question
                        after: pick || slash ? async name => {
                            if (pick) {
                                await confirmModelSwitch(name).catch(() => false);
                                await restore?.();
                            }
                            result = await settleCommand(name, body.trim()).catch(() => null);
                        } : null
                    });
                    const warning = await runningTwice(url.searchParams.get('id'));
                    if (result) {
                        return json({ ...result, warning });
                    }
                    return res.end(warning ?? said); // sent; any other text is a warning
                }
                return res.end('ok');
                } catch (e) {
                    if (once) {
                        release(sentRows, once); // a failed send is retried with the same key
                    }
                    throw e;
                }
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
            if (isPost('/api/push')) {
                let input;
                try {
                    input = JSON.parse(await readBody(req, 1024));
                } catch {
                    return deny(400, 'expected a JSON body');
                }
                return json(await pushSession(input?.session));
            }
            if (isPost('/api/interrupt')) {
                await interrupt(url.searchParams.get('id'));
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
            if (isPost('/api/issues/start')) {
                let input;
                try {
                    input = JSON.parse(await readBody(req, 1024));
                } catch {
                    return deny(400, 'expected a JSON body');
                }
                return json(await startIssue(input));
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
                const lim = await limits();
                await syncSaver(lim, DATA_DIR); // usage crossing the auto-on line flips the saver here, on the client's poll
                return json(lim);
            }
            // Read-only, for whoever may read a chat (paired devices too). The folder is the session's own, never the request's.
            if (url.pathname === '/api/diff' && req.method === 'GET') {
                const q = url.searchParams;
                return json(await diff(q.get('session'), q.get('item'), q.get('group'), q.get('file')));
            }
            if (url.pathname === '/api/agent-feed') {
                const q = url.searchParams;
                return json(await agentFeed(await polledSessions(), q.get('session'), q.get('agent'), q.get('max')));
            }
            if (url.pathname === '/api/transcript') {
                return json(await transcript(url.searchParams.get('dir'), url.searchParams.get('id'), url.searchParams.get('max')));
            }
            res.statusCode = 404;
            res.end('not found');
        } catch (e) {
            const [status, text] = errorReply(e);
            res.statusCode = status;
            if (e?.body) {
                return json(e.body);
            }
            res.end(text);
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
            await watchSessions(DATA_DIR, await polledSessions());
        } catch (e) {
            console.error(`push: ${e.message}`);
        }
    }, 5000);
}
