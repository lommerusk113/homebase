// MR row buttons that start a fresh helper (server/helpers.mjs) instead of typing into the MR's busy chat: Rebase (a real
// conflict), Fix pipeline and Fix & reply. One function, startActionHelper, for the row buttons (POST /api/action) and for
// the merge queue (server/queue.mjs) alike. The helper's brief is fixed text with the MR's facts; it nests under the MR's row.
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './entries.mjs';
import { mrRef, mrNumber } from './forge.mjs';
import { helpers, withLock } from './tmux.mjs';
import { startHelper, parentTmux, chatIn, running } from './helpers.mjs';

const run = promisify(execFile);
const bad = (status, message) => Object.assign(new Error(message), { status });

// action -> the row kind whose button it is, the helper's title verb, and its job.
export const ACTIONS = {
    conflict: { verb: 'Rebase', job: ({ source, target, sha }) => `Rebase the branch onto \`origin/${target}\` and resolve the conflicts by meaning, not by picking a side: read what each side meant to do, keep both intents, and check the result builds and its tests pass. Then push the result to the MR's branch with \`git push --force-with-lease=${source}:${sha ?? `origin/${source}`} origin HEAD:${source}\` (the lease is the head the board saw; if it fails, fetch, look at what moved and redo the rebase).` },
    failing: { verb: 'Fix pipeline of', job: ({ source }) => `The pipeline on the MR's branch is failing. Read the failed job's log (\`glab ci status\` / \`glab ci trace <job>\`, or \`gh run view --log-failed\` on GitHub), find the cause, fix it in the code (not by skipping the check), run the project's own checks, and push with \`git push origin HEAD:${source}\`.` },
    changes: { verb: 'Address review of', job: ({ source, pr }) => `Address the open review threads on the MR (\`glab mr view ${mrNumber(pr)} --comments\`, or \`gh pr view ${mrNumber(pr)} --comments\`): read every unresolved thread and every comment that waits for an answer, make the changes they ask for (or, where you disagree, say why), run the project's own checks, push with \`git push origin HEAD:${source}\`, and reply in each thread saying what you did.` }
};

/** The helper's first message for an MR's action, from the MR's facts: { pr, title, source, target, sha }; transcript: the owning chat's .jsonl or null. */
export function actionBrief(action, mr, transcript = null) {

    const a = ACTIONS[action];
    if (!a) {
        throw bad(400, `no such action: ${action}`);
    }

    return [
        `Job: ${a.verb} ${mrRef(mr.pr)} "${mr.title ?? ''}".`,
        `MR: ${mr.pr} (${mrRef(mr.pr)}), source branch \`${mr.source}\`, target branch \`${mr.target ?? 'its target'}\`.`,
        `Your worktree is on a local branch at \`origin/${mr.source}\`; the MR's branch is \`${mr.source}\`, so pushes go to \`HEAD:${mr.source}\`. Run \`git fetch origin\` first.`,
        '',
        a.job(mr),
        '',
        'Follow the project\'s own rules (CLAUDE.md, README, CONTRIBUTING): its checks before a push, its commit message format, and whatever your global instructions say about asking before a push. Pushing this MR\'s branch is your job here, the one exception to "do not push"; do not merge the MR, open another one or touch other branches.',
        'Report progress with `homebase status doing --mr ' + mr.pr + ' "<what you do now>"`, `homebase status needs-you --mr ' + mr.pr + ' "<question>"` when you need me, and `homebase status done` when finished.',
        transcript ? `Earlier discussion of this MR is in ${transcript}; read it (grep for the MR ref, thread ids or file names, or the tail) only if you need context the MR and branch don't give. Read-only: never send anything to that chat.` : null
    ].filter(x => x !== null).join('\n');
}

/**
 * The chat that owns an MR, from the board's session list: the one whose folder has the MR's branch checked out, else the
 * row's own chat (the one that opened it), else null. A helper's chat is replaced by its parent chat.
 */
export function owningChat(list, { project, source, sessionId }, registry = helpers) {

    const chat = list.find(s => s.project === project && !!source && (s.head ?? s.branch) === source && !registry.has(s.id)) ?? list.find(s => s.id === sessionId);
    const h = chat && registry.get(chat.id);

    return (h ? chatIn(list, parentTmux(h)) : chat) ?? null;
}

/**
 * Starts the helper for `action` ('conflict' | 'failing' | 'changes') on an MR { key, pr, project, title, source, target, sha, sessionId },
 * nested under the MR's row. One per MR and action while it runs: a second call returns that one, { helper, existing: true }.
 * list: the board's sessions (for the owning chat). Never throws for a repeat; a missing chat or branch is a 409.
 */
export async function startActionHelper(dir, mr, action, list, { start = startHelper, fetchBranch = fetchOrigin, registry = helpers, ...opts } = {}) {

    if (!ACTIONS[action]) {
        throw bad(400, `no such action: ${action}`);
    }
    const tag = `${action}:${mr.pr}`;

    return withLock(`action:${tag}`, async () => { // two clicks at once start one
        const open = running().find(h => h.action === tag);

        return open ? { helper: open, existing: true } : begin(dir, mr, action, tag, list, { start, fetchBranch, registry, ...opts });
    });
}

async function begin(dir, mr, action, tag, list, { start, fetchBranch, registry, ...opts }) {

    if (!mr.source) {
        throw bad(409, 'the MR has no known source branch yet: try again after the next refresh');
    }
    const chat = owningChat(list, mr, registry);
    if (!chat) {
        throw bad(409, 'no chat of this project is open to nest the helper under: open one first');
    }

    await fetchBranch(chat.cwd, [mr.source, mr.target].filter(Boolean)); // the worktree starts from origin/<source>
    const transcript = chat.dir ? join(ROOT, chat.dir, `${chat.id}.jsonl`) : null;
    const helper = await start(dir, chat, {
        brief: actionBrief(action, mr, transcript),
        title: `${ACTIONS[action].verb} ${mrRef(mr.pr)}`,
        model: 'sonnet',
        base: `origin/${mr.source}`,
        meta: { action: tag, mr: mr.pr }
    }, opts);

    return { helper, existing: false };
}

const fetchOrigin = (cwd, branches) => run('git', ['-C', cwd, 'fetch', 'origin', ...branches], { timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    .catch(e => { throw bad(409, `git fetch: ${(e.stderr || e.message).trim().split('\n')[0]}`); });
