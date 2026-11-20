// Request checks (pure): allowed Host/Origin and the API token. Pairing for remote devices is in pairing.mjs.
import { timingSafeEqual } from 'node:crypto';

// Who may talk to the server. POSTs type into sessions that run shell commands, so every request must come from our own page:
// Host stops DNS rebinding, Origin and the per-start token stop other websites (a cross-origin page cannot read the token).
export const localHosts = port => ['localhost', '127.0.0.1', '[::1]'].map(h => `${h}:${port}`);
export const allowedHost = (host, hosts) => hosts.includes(host);
// Local pages are http. The remote host is reached over https through tailscale serve; http:// of that exact name is
// also accepted (only the Mac serves it, and the browser tests reach the remote port over http://localhost).
export const allowedOrigin = (origin, hosts, schemes = ['http']) => origin === undefined || hosts.some(h => schemes.some(s => origin === `${s}://${h}`));
export function tokenOk(given, expected) {

    if (typeof given !== 'string' || typeof expected !== 'string') {
        return false;
    }

    const a = Buffer.from(given), b = Buffer.from(expected);

    return a.length === b.length && timingSafeEqual(a, b);
}
