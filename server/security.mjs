// Request checks (pure): allowed Host/Origin and the API token.
import { hostname, networkInterfaces } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

// Who may talk to the server. POSTs type into sessions that run shell commands, so every request must come from our own page:
// Host stops DNS rebinding, Origin and the per-start token stop other websites (a cross-origin page cannot read the token),
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
export const bindOk = (addr, lan) => addr === '127.0.0.1' || (lan && addr === '0.0.0.0');
