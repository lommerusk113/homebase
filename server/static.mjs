// Static files: the fixed app file map, the build hash, the CSP, public/vendor serving and revalidation.
import { readFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const JS = 'text/javascript; charset=utf-8';

// The page's files. A fixed map, so no request path ever reaches the file system.
export const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', JS],
    '/core.js': ['core.js', JS],
    '/list.js': ['list.js', JS],
    '/chat.js': ['chat.js', JS],
    '/milestone.js': ['milestone.js', JS],
    '/issues.js': ['issues.js', JS],
    '/keys.js': ['keys.js', JS],
    '/log.js': ['log.js', JS],
    '/icon.svg': ['icon.svg', 'image/svg+xml']
};
// Hash of the app files as of this start, in index.html's homebase-build meta: a page whose build differs from a
// freshly served index.html runs old code and says "reload when convenient". A restart without code changes keeps it.
// ponytail: vendor files aren't hashed; they change only with a VENDOR.md update, which comes with app changes anyway
export const BUILD = createHash('sha1').update(Object.values(STATIC).map(([f]) => readFileSync(new URL(`../public/${f}`, import.meta.url))).join('\0')).digest('base64url').slice(0, 12);

// No third-party origins: everything, Web Awesome included, comes from public/vendor. data: is for Web Awesome's
// built-in icons, which it renders as data: SVG URLs and loads with fetch(). Its components set inline styles.
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Third-party code copied into public/vendor (see VENDOR.md). Only these extensions are ever served from there.
const VENDOR_DIR = fileURLToPath(new URL('../public/vendor', import.meta.url));
const VENDOR_TYPES = {
    '.js': JS,
    '.mjs': JS,
    '.css': 'text/css; charset=utf-8',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
    '.json': 'application/json'
};

// '/vendor/a/b.js' -> 'a/b.js', or null for anything that could leave public/vendor or isn't an allowed type.
// Pure: symlinks are checked against the real path when serving.
export function vendorPath(urlPath) {

    if (typeof urlPath !== 'string' || !urlPath.startsWith('/vendor/')) {
        return null;
    }

    let rel;
    try {
        rel = decodeURIComponent(urlPath.slice('/vendor/'.length));
    } catch {
        return null;
    }

    // no '..', '.', dotfiles, empty segments, backslashes or NULs
    const bad = rel.split('/').some(p => p === '' || p.startsWith('.')) || /[\\\0]/.test(rel);
    if (bad || !Object.hasOwn(VENDOR_TYPES, extname(rel))) {
        return null;
    }

    return rel;
}

// App and vendor files: the browser revalidates on every load (a cheap 304 when unchanged), so after a restart it
// never runs stale modules next to a fresh index.html. Vendor paths carry no version (VENDOR.md updates files in
// place), so they get the same treatment rather than long-lived caching.
export function sendRevalidated(req, res, body) {

    const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('etag', etag);
    if (req.headers['if-none-match']?.split(/\s*,\s*/).includes(etag)) {
        res.statusCode = 304;
        return res.end();
    }

    return res.end(body);
}

export async function serveVendor(rel, req, res) {

    const root = await realpath(VENDOR_DIR);
    const file = await realpath(join(root, rel)).catch(() => null);
    if (!file?.startsWith(root + sep)) {
        return false;
    }

    res.setHeader('content-type', VENDOR_TYPES[extname(file)]);
    res.setHeader('x-content-type-options', 'nosniff');
    sendRevalidated(req, res, await readFile(file));

    return true;
}
