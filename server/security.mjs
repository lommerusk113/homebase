// Request checks (pure): allowed Host/Origin, the API token, the LAN pairing cookie and code, and the pairing rate limit.
import { hostname, networkInterfaces } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

// Who may talk to the server. POSTs type into sessions that run shell commands, so every request must come from our own page:
// Host stops DNS rebinding, Origin and the per-start token stop other websites (a cross-origin page cannot read the token),
// and in LAN mode a paired-device cookie stops other machines on the network.
export const localHosts = port => ['localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${port}`);
export function isPrivateIp(ip) {

    const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip ?? '');
    if (!m) {
        return false;
    }

    const a = Number(m[1]), b = Number(m[2]);

    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
// LAN mode: localhost, <hostname>.local and the current private IPv4 addresses, each with the port.
export function lanHosts(port, name = hostname(), ifaces = networkInterfaces()) {

    const local = name.toLowerCase().endsWith('.local') ? name.toLowerCase() : `${name.toLowerCase()}.local`;
    const ips = Object.values(ifaces).flat().filter(i => i && isPrivateIp(i.address)).map(i => i.address);

    return [...localHosts(port), ...[local, ...ips].map(h => `${h}:${port}`)];
}
export const allowedHost = (host, hosts) => hosts.includes(host);
export const allowedOrigin = (origin, hosts) => origin === undefined || hosts.some(h => origin === `http://${h}`);
export function tokenOk(given, expected) {

    if (typeof given !== 'string' || typeof expected !== 'string') {
        return false;
    }

    const a = Buffer.from(given), b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
}
export const COOKIE = 'homebase_session';
export const cookieOk = (header, secret) => tokenOk((header ?? '').split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1), secret);
export const isLoopback = addr => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
export const bindOk = (addr, lan) => addr === '127.0.0.1' || (lan && addr === '0.0.0.0');
// max tries per key per window, then locked out for lockMs.
// ponytail: one map entry per client IP that ever tried, never pruned; fine on a home network
export function rateLimiter(max = 5, windowMs = 60_000, lockMs = 15 * 60_000) {

    const seen = new Map();

    return (key, now = Date.now()) => {

        let e = seen.get(key);
        if (!e || (now - e.start > windowMs && now >= e.lockedUntil)) {
            e = { start: now, count: 0, lockedUntil: 0 };
            seen.set(key, e);
        }
        if (now < e.lockedUntil) {
            return false;
        }
        if (++e.count > max) {
            e.lockedUntil = now + lockMs;
            return false;
        }

        return true;
    };
}
// 8 chars from 32 unambiguous letters and digits (40 bits); 256 % 32 == 0, so no modulo bias.
export const pairingCode = () => [...randomBytes(8)].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
export const pairPage = msg => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair with Homebase</title>
<style>body{font:16px system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 16px}input,button{font:inherit;padding:.4rem .6rem}input{text-transform:uppercase;letter-spacing:.1em}</style></head>
<body><h1>Pair this device</h1><p>Enter the pairing code shown in the terminal running Homebase, or run <code>cat ~/.claude/homebase/pairing-code</code> on that machine.</p>
${msg ? `<p><strong>${msg}</strong></p>` : ''}<form method="post" action="/pair"><input name="code" autocomplete="off" autofocus required maxlength="16"> <button>Pair</button></form></body></html>`;
