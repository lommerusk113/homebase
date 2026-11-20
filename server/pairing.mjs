// Remote access through `tailscale serve`, gated by pairing. `tailscale serve` proxies the tailnet's HTTPS to a second
// loopback port (remote.port), so every request on that port is remote, whatever its Host header says (serve picks
// its route by TLS SNI and passes the Host through, so a tailnet peer could send `Host: localhost`).
// A remote request needs a paired-device cookie; pairing takes a one-time code shown on the Mac's own Homebase.
// The server keeps only each cookie's SHA-256, in devices.json.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

export const CODE_TTL_MS = 5 * 60_000;
export const MAX_FAILS = 5; // wrong codes per FAIL_WINDOW_MS, for all devices together (they all arrive from 127.0.0.1)
export const FAIL_WINDOW_MS = 60_000;
export const COOKIE = 'homebase_device';
const COOKIE_MAX_AGE_S = 400 * 86_400; // the most Chrome keeps
const SEEN_EVERY_MS = 60_000; // lastSeen is written at most this often per device

let file = null, remote = null, devices = [], code = null, fails = [];

const fail = (status, message) => Object.assign(new Error(message), { status });

// config.json's `remote` ({ host, port?, login? }) -> { host, port, login }, or null when absent. Exact host only, no wildcard.
export function remoteFrom(config, localPort) {

    const r = config?.remote;
    if (r === undefined) {
        return null;
    }

    const host = typeof r?.host === 'string' ? r.host.toLowerCase() : '';
    const port = r?.port ?? localPort + 1;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || port === localPort
        || (r?.login !== undefined && typeof r.login !== 'string')) {
        throw new Error('config.json: remote must be { "host": "<mac>.<tailnet>.ts.net", "port"?: <number>, "login"?: "<tailscale login>" }');
    }

    return { host, port, login: r.login ?? '' };
}

// Called once at start: where the devices live and the remote config (null = no remote listener).
export function setupPairing(path, remoteConfig) {

    file = path;
    remote = remoteConfig;
    code = null;
    fails = [];
    try {
        devices = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        devices = [];
    }
}

function save() {

    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
}

const hashOf = secret => createHash('sha256').update(secret).digest('hex');

// A new one-time code replaces any earlier one.
export function newCode(now = Date.now()) {

    code = { value: String(randomInt(0, 1_000_000)).padStart(6, '0'), expires: now + CODE_TTL_MS };

    return { code: code.value, expiresAt: code.expires };
}

// The code entered on the phone -> the device's cookie secret. Throws 429 when rate limited, 401 when wrong or expired.
export function pair(given, name, now = Date.now()) {

    fails = fails.filter(t => now - t < FAIL_WINDOW_MS);
    if (fails.length >= MAX_FAILS) {
        throw fail(429, 'Too many tries. Wait a minute and try again.');
    }
    if (code && now >= code.expires) {
        code = null;
    }

    const typed = Buffer.from(String(given ?? '').replace(/\s/g, ''));
    if (!code || typed.length !== code.value.length || !timingSafeEqual(typed, Buffer.from(code.value))) {
        fails.push(now);
        throw fail(401, 'That code is wrong or has expired. Make a new one on the Mac.');
    }

    code = null; // single use
    const secret = randomBytes(32).toString('hex');
    const label = String(name ?? '').replace(/[\p{C}]/gu, '').trim().slice(0, 40) || 'Device';
    devices.push({ id: randomBytes(8).toString('hex'), hash: hashOf(secret), name: label, created: now, lastSeen: now });
    save();

    return secret;
}

export const deviceCookie = secret => `${COOKIE}=${secret}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;

export function cookieOf(header, name = COOKIE) {

    for (const part of String(header ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) {
            return part.slice(i + 1).trim();
        }
    }

    return null;
}

// The paired device a cookie secret belongs to, or null; touches its lastSeen.
export function deviceOf(secret, now = Date.now()) {

    if (typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret)) {
        return null;
    }

    const hash = hashOf(secret);
    const d = devices.find(x => x.hash === hash);
    if (d && now - d.lastSeen >= SEEN_EVERY_MS) {
        d.lastSeen = now;
        save();
    }

    return d ?? null;
}

export const pairedDevices = () => devices.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }));

export function revoke(id) {

    const before = devices.length;
    devices = devices.filter(d => d.id !== id);
    if (devices.length === before) {
        return false;
    }
    save();

    return true;
}

// Remote = arrived on the tailscale serve port. Local requests come from the Mac itself.
export const isRemote = req => remote !== null && req.socket?.localPort === remote.port;
export const remoteHosts = () => (remote ? [remote.host] : []);

// The optional second factor: tailscale serve strips any client-sent Tailscale-User-Login and sets the real one,
// so it can be trusted only on the remote port, which only serve reaches (it is bound to 127.0.0.1).
export const loginOk = req => !remote?.login || req.headers['tailscale-user-login'] === remote.login;

// For other features: may this request see Homebase? Local requests: yes. Remote ones: the login matches and the
// device is paired. The Host/Origin checks and the API token still apply on top.
export const isPairedRequest = (req, now = Date.now()) => !isRemote(req) || (loginOk(req) && deviceOf(cookieOf(req.headers.cookie), now) !== null);

// The page an unpaired remote device gets instead of Homebase. No script; the form posts to /pair.
export const pairPage = (message = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="homebase-pair" content="1"><title>Pair this device · Homebase</title>
<style>body{font:16px system-ui,sans-serif;max-width:22rem;margin:3rem auto;padding:0 16px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#eee;background:#1b1b1f}}
label{display:block;margin:1rem 0 .3rem}input,button{font:inherit;width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #888}
button{margin-top:1.2rem;background:#2563eb;color:#fff;border:0}.err{color:#d33}</style></head>
<body><h1>Pair this device</h1>
<p>On the Mac, open Homebase, then ☰ → Pair a device…, and type the code it shows.</p>
${message ? `<p class="err" role="alert">${message.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)}</p>` : ''}
<form method="post" action="/pair">
<label for="code">Code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus>
<label for="name">Name for this device</label><input id="name" name="name" maxlength="40" value="Phone">
<button type="submit">Pair</button></form></body></html>`;
