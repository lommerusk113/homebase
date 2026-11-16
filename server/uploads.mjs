// Images attached to chat messages: POST /api/upload stores one under a generated name, GET /api/upload/<name> serves it.
// The message carries the absolute path as "[Image: <path>]"; Claude Code's Read tool opens images by path.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPLOAD_MAX = 10 * 1024 * 1024;
export const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SERVE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
// Only names saveUpload makes, so a request path never leaves the uploads folder.
export const UPLOAD_NAME = /^[0-9a-f-]{36}\.(png|jpe?g|gif|webp)$/;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Stores the body as <uuid>.<ext> in dir and returns its absolute path. The name never comes from the client.
export async function saveUpload(body, contentType, length, dir) {

    const ext = UPLOAD_TYPES[String(contentType ?? '').split(';')[0].trim().toLowerCase()];
    if (!ext) {
        throw fail(415, 'only PNG, JPEG, GIF or WebP images');
    }
    if (Number(length) > UPLOAD_MAX) {
        throw fail(413, 'image larger than 10 MB');
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
        size += chunk.length;
        if (size > UPLOAD_MAX) {
            throw fail(413, 'image larger than 10 MB');
        }
        chunks.push(chunk);
    }
    if (!size) {
        throw fail(400, 'empty image');
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${randomUUID()}.${ext}`);
    await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });

    return path;
}

// { type, body } of an uploaded image, or null for any name saveUpload could not have made or that isn't there.
export async function readUpload(name, dir) {

    const m = UPLOAD_NAME.exec(name);
    if (!m) {
        return null;
    }

    const body = await readFile(join(dir, name)).catch(() => null);

    return body && { type: SERVE_TYPES[m[1]], body };
}
