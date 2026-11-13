// Dashboard over Claude Code transcripts in ~/.claude/projects. Only types into its own tmux sessions; writes files only in LAN mode (pairing code, session secret).
// Entry point: config, startup and the router. Everything else lives in server/ (see server/README.md); what test.mjs uses is re-exported here.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { transcript } from './server/transcripts.mjs';
import { sessions } from './server/sessions.mjs';
import { refreshAll, refreshInfo } from './server/forge.mjs';
import { milestones, warmMilestones } from './server/milestones.mjs';
import { limits } from './server/limits.mjs';
import { MAX_SEND } from './server/tmux.mjs';
import { send, interrupt, clearChat, editors, openInEditor } from './server/control.mjs';
import { localHosts, lanHosts, allowedHost, allowedOrigin, tokenOk, COOKIE, cookieOk, isLoopback, bindOk, rateLimiter, pairingCode, pairPage } from './server/security.mjs';
import { STATIC, BUILD, CSP, vendorPath, sendRevalidated, serveVendor } from './server/static.mjs';

export {
    readTail, filesTouched, splitTopic, splitTldr, gateRuns, toolSummary, unwrapPasted, chatItems, quickReplies,
    pendingAsk, pendingQuestion, turnState, turnPrompts, latestTopic, queuedPrompts, addUsage, readUsage, formatDuration, formatTokens
} from './server/transcripts.mjs';
export { repoName, repoPath, agentStage, agentStatus, summarizeAgent, status, lastActivity, summarize, folderFor } from './server/sessions.mjs';
export { pipelineOf, ciOf, issueOf, mentionsMr, limiter, dedupe, refetch, refreshDue, excerpt, withThreads, isBot, humanComments, fetchComments, swrEntry, swr, cached, refreshAll, refreshInfo } from './server/forge.mjs';
export {
    column, gateFor, toGate, itemColumn, nextStep, rowAction, sameRepo, worksOnMr, requestFor, workItems, milestoneOf
} from './server/items.mjs';
export { keepMilestone, worksOn, groupIssues, activeMilestones, noMilestones } from './server/milestones.mjs';
export { limitsOf, peakLimits } from './server/limits.mjs';
export { tmuxArgs, tmuxFor, findClearedSuccessor, sendSteps, refuseIfLiveElsewhere } from './server/tmux.mjs';
export { editorsFrom, openInEditor } from './server/control.mjs';
export { localHosts, isPrivateIp, lanHosts, allowedHost, allowedOrigin, tokenOk, cookieOk, isLoopback, bindOk, rateLimiter, pairingCode } from './server/security.mjs';
export { vendorPath } from './server/static.mjs';

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

const LAN = process.env.HOMEBASE_LAN === '1';
const BIND = LAN ? '0.0.0.0' : '127.0.0.1';
const DATA_DIR = process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
const TOKEN = randomBytes(32).toString('hex');
const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const pairLimit = rateLimiter();
const PAIR_BODY_MAX = 200; // "code=XXXXXXXX" with room to spare
const PAIR_COOKIE_MAX_AGE_S = 365 * 24 * 3600;

function writeSecret(name, value) {

    const path = join(DATA_DIR, name);
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(path, value + '\n', { mode: 0o600 });
    chmodSync(path, 0o600); // mode only applies when the file is created

    return value;
}
// LAN mode only: a fresh pairing code per start, and a session secret that survives restarts until its file is deleted.
function lanSecrets() {

    if (!LAN) {
        return {};
    }

    let session;
    try {
        session = readFileSync(join(DATA_DIR, 'session-secret'), 'utf8').trim();
    } catch {}

    return { code: writeSecret('pairing-code', pairingCode()), session: session || writeSecret('session-secret', randomBytes(32).toString('hex')) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    if (!bindOk(BIND, LAN)) {
        throw new Error(`refusing to listen on ${BIND}: Homebase binds to 127.0.0.1 unless HOMEBASE_LAN=1`);
    }
    const { code: PAIR_CODE, session: SESSION_SECRET } = lanSecrets();
    if (LAN) {
        console.log(`LAN mode: pairing code ${PAIR_CODE} (also in ${join(DATA_DIR, 'pairing-code')})`);
    }
    editors();
    warmMilestones();
    createServer(async (req, res) => {
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
        const hosts = LAN ? lanHosts(PORT) : localHosts(PORT);
        if (!allowedHost(req.headers.host, hosts) || !allowedOrigin(req.headers.origin, hosts)) {
            return deny(403, 'forbidden');
        }
        const site = req.headers['sec-fetch-site'];
        if (req.method === 'POST' && site !== undefined && site !== 'same-origin') {
            return deny(403, 'forbidden');
        }
        // Other machines (LAN mode only) pair once with the code; until then they get the pairing page and nothing else.
        if (!isLoopback(req.socket.remoteAddress) && !cookieOk(req.headers.cookie, SESSION_SECRET)) {
            res.setHeader('cache-control', 'no-store');
            res.setHeader('content-security-policy', CSP); // the pairing page: a plain form POST, no scripts
            if (url.pathname === '/pair' && req.method === 'POST') {
                if (!pairLimit(req.socket.remoteAddress)) {
                    return deny(429, 'too many tries, wait 15 minutes');
                }
                let code = '';
                try {
                    code = new URLSearchParams(await readBody(req, PAIR_BODY_MAX)).get('code')?.trim().toUpperCase() ?? '';
                } catch {}
                if (!tokenOk(code, PAIR_CODE)) {
                    res.setHeader('content-type', 'text/html; charset=utf-8');
                    return deny(403, pairPage('Wrong code.'));
                }
                res.setHeader('set-cookie', `${COOKIE}=${SESSION_SECRET}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${PAIR_COOKIE_MAX_AGE_S}`);
                res.setHeader('location', '/');
                res.statusCode = 303;
                return res.end();
            }
            if (url.pathname === '/' || url.pathname === '/index.html') {
                res.setHeader('content-type', 'text/html; charset=utf-8');
                return res.end(pairPage(''));
            }
            return deny(401, 'unauthorized');
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
                // The token reaches only a page served to a request that passed the Host, Origin and pairing checks above.
                res.setHeader('content-security-policy', CSP);
                res.setHeader('cache-control', 'no-store');
                return res.end(String(body).replace('__HOMEBASE_TOKEN__', TOKEN).replace('__HOMEBASE_BUILD__', BUILD));
            }
            const vendored = vendorPath(url.pathname);
            if (vendored && await serveVendor(vendored, req, res)) {
                return;
            }
            if (url.pathname === '/api/sessions') {
                return json(await sessions());
            }
            if (isPost('/api/send')) {
                await send(url.searchParams.get('id'), await readBody(req, MAX_SEND));
                return res.end('ok');
            }
            if (isPost('/api/clear')) {
                await clearChat(url.searchParams.get('id'));
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
            if (url.pathname === '/api/milestones') {
                return json(await milestones(url.searchParams.get('project'), url.searchParams.get('milestone')));
            }
            if (url.pathname === '/api/limits') {
                return json(await limits());
            }
            if (url.pathname === '/api/transcript') {
                return json(await transcript(url.searchParams.get('dir'), url.searchParams.get('id')));
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
    }).listen(PORT, BIND, () => console.log(`Homebase on http://localhost:${PORT}`));
}
