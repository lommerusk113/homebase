// Request checks (pure): allowed Host/Origin and the API token; plus owner-only modes for the data dir. Pairing for remote devices is in pairing.mjs.
import { chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// Called once at start: the Homebase dir, the hook's markers, the statusline dumps and server.log become owner-only.
// New ones are created that way (hooks/asking.mjs, scripts/statusline.sh, reload.mjs); this tightens what an earlier
// version left 0755/0644. Missing files and folders are skipped.
export function ownerOnly(dataDir) {

    const chmod = (path, mode) => {
        try {
            chmodSync(path, mode);
        } catch {}
    };

    chmod(dataDir, 0o700);
    chmod(join(dataDir, 'server.log'), 0o600);
    for (const sub of ['asking', 'statusline']) {
        const dir = join(dataDir, sub);
        chmod(dir, 0o700);
        let names = [];
        try {
            names = readdirSync(dir);
        } catch {}
        for (const n of names) {
            chmod(join(dir, n), 0o600);
        }
    }
}

// What an API caller is told about a thrown error -> [status, text]. An error with a status is a deliberate refusal and
// keeps its message. Any other is a raw Node error, whose message can hold absolute paths: fixed text, detail logged here.
export function errorReply(e, log = console.error) {

    if (e?.status) {
        return [e.status, String(e.message)];
    }
    log(e);

    return [500, 'Internal error: the detail is in the server output'];
}
