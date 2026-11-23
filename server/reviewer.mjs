// Review chats: the Review button on an "In review" row starts a separate Claude (its own cc-<id8> tmux, in the row's
// checkout) that reviews the branch read-only. Which chat belongs to which row is kept in reviewers.json in the Homebase dir.
// The prompt is fixed text: nothing from GitLab or the row goes into it.
import { readFileSync } from 'node:fs';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { reviewers } from './items.mjs';
import { keepAside } from './account.mjs';
import { tmux, tmuxName, claudeLine, loginShell, quoted } from './tmux.mjs';

const MAX = 200;
// Real read-only, not just the prompt. Variadic flag: it comes before --session-id so the prompt after it stays the prompt.
export const READ_ONLY = 'Edit Write NotebookEdit';
const ID = /^[0-9a-f-]{36}$/;
const KEY = /^.{1,300}$/;

export const REVIEW_PROMPT = {
    work: 'Run review-gate on this branch against its MR target. Read-only: do not edit, commit or push. End with the findings table and verdict.',
    hobby: "Run /code-review on this branch's changes vs main. Read-only: do not edit, commit or push. End with the findings."
};

// At server start: what was saved, or nothing when the file is missing or broken (a broken one is set aside).
export function loadReviewers(dir) {

    let saved;
    try {
        saved = JSON.parse(readFileSync(join(dir, 'reviewers.json'), 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') {
            keepAside(join(dir, 'reviewers.json'), e.message, 'review chats lose their rows');
        }
    }
    reviewers.clear();
    for (const [key, r] of Array.isArray(saved) ? saved.slice(-MAX) : []) {
        if (KEY.test(key ?? '') && ID.test(r?.id ?? '') && Number.isFinite(r.at)) {
            reviewers.set(key, { id: r.id, at: r.at, sent: !!r.sent });
        }
    }
}

async function save(dir) {

    const file = join(dir, 'reviewers.json'), tmp = `${file}.tmp`;
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify([...reviewers].slice(-MAX)), { mode: 0o600 });
    await rename(tmp, file);
}

const bad = (status, message) => Object.assign(new Error(message), { status });

// Starts the reviewer for a row (key) in cwd. One per row: refused while the last one's findings are not sent yet.
// gitlab: a work repo (review-gate) rather than a hobby one. Never pushes or merges: the chat is only told not to.
export async function startReviewer(dir, { key, cwd, gitlab }, { tm = tmux, now = Date.now(), newId = randomUUID } = {}) {

    if (!KEY.test(key ?? '') || typeof cwd !== 'string') {
        throw bad(400, 'bad row');
    }
    const old = reviewers.get(key);
    if (old && !old.sent) {
        throw bad(409, 'This row already has a reviewer: open it, or send its findings first');
    }

    const id = newId();
    // --session-id names the chat up front, so its tmux (cc-<id8>) is known before its transcript exists; the prompt is its first message
    await tm(['new-session', '-d', '-s', tmuxName(id), '-c', cwd, loginShell(), '-lic', claudeLine(` --disallowedTools ${quoted(READ_ONLY)} --session-id ${id} ${quoted(REVIEW_PROMPT[gitlab ? 'work' : 'hobby'])}`)]);
    reviewers.set(key, { id, at: now, sent: false });
    await save(dir);

    return id;
}

// The row's findings went into its working chat: the next Review starts a fresh reviewer.
export async function markFindingsSent(dir, key) {

    const r = reviewers.get(key);
    if (!r) {
        throw bad(404, 'no reviewer for this row');
    }
    r.sent = true;
    await save(dir);
}
