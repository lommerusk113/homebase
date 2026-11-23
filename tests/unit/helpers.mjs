// Fixtures more than one unit file uses.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prState } from '../../server/forge.mjs';

export const tu = (name, extra) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, ...extra }] } });
export const say = text => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
export const T = s => `2026-11-12T22:11:${s}Z`;
export const open = extra => ({ state: 'open', reviewers: [], ...extra });
export const mr = n => `https://gitlab.com/g/p/-/merge_requests/${n}`;
export const agent = (id, updated, extra) => ({ id, updated, status: 'done', stage: 4, prs: [], description: id, ...extra });
export const now = 1_738_400_000_000;

// A stand-in for the code tree whose mtimes the server watches (HOMEBASE_CODE_DIR): tests touch it, never the real files other runs share.
export function codeDir(dir = mkdtempSync(join(tmpdir(), 'hb-code-'))) {

    for (const f of ['server.mjs', 'server/rules.mjs', 'public/styles.css']) {
        mkdirSync(join(dir, f, '..'), { recursive: true });
        writeFileSync(join(dir, f), '');
    }

    return dir;
}

// fake glab first on PATH for the forge tests; each test passes the script body it needs
export const fakeBin = mkdtempSync(join(tmpdir(), 'hb-forge-'));
export const withFakeGlab = async (body, fn) => {
    writeFileSync(join(fakeBin, 'glab'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${fakeBin}:${path}`;
    try {
        return await fn();
    } finally {
        process.env.PATH = path;
    }
};

// a GitLab MR as glab answers it; fields not given are the plain open, unblocked defaults
export const glabMr = (fields, n) => withFakeGlab(`echo '${JSON.stringify({ state: 'opened', title: 't', source_branch: 'b', detailed_merge_status: 'mergeable', ...fields })}'`,
    () => prState(`https://gitlab.example.com/g/p/-/merge_requests/${n}`));
