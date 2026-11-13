// A throwaway HOME with Claude Code transcripts for three projects, git repos whose origins name them, and fake
// glab/gh executables (forge-stub.mjs) first on PATH. Timestamps are relative to now, so states are deterministic.
import { mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const IDS = {
    master: 'aaaaaaaa-0000-4000-8000-000000000001', // alpha, idle: chat history, topics, needs you, TLDR fold, quick replies, answer tag, API error, huge line
    asker: 'aaaaaaaa-0000-4000-8000-000000000002', // beta, pending AskUserQuestion
    worker: 'aaaaaaaa-0000-4000-8000-000000000003', // alpha, open turn with a queued message
    gamma: 'aaaaaaaa-0000-4000-8000-000000000004', // gamma, whose forge calls fail
    other: 'aaaaaaaa-0000-4000-8000-000000000005' // alpha, written to by the binding test
};
export const MR = n => `https://gitlab.com/acme/alpha/-/merge_requests/${n}`;

const ago = s => new Date(Date.now() - s * 1000).toISOString();
const jsonl = entries => entries.map(e => JSON.stringify(e)).join('\n') + '\n';
const said = (text, s, extra = {}) => ({ type: 'assistant', uuid: `a${s}`, timestamp: ago(s), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] }, ...extra });
const tool = (name, input, s, id = `t${s}`) => ({ type: 'assistant', uuid: `a${s}`, timestamp: ago(s), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const prompt = (text, s) => ({ type: 'user', uuid: `u${s}`, timestamp: ago(s), origin: { kind: 'human' }, promptSource: 'typed', turnPosition: { promptIndex: 1, turnIndex: 1 }, message: { role: 'user', content: text } });
const result = (id, content, s) => ({ type: 'user', uuid: `r${s}`, timestamp: ago(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const done = s => ({ type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp: ago(s) });
const link = (n, s) => ({ type: 'pr-link', prUrl: MR(n), timestamp: ago(s) });

function session(home, project, id, entries, mtimeAgo) {

    const dir = join(home, '.claude', 'projects', `-fx-${project}`);
    mkdirSync(dir, { recursive: true });
    const base = { isSidechain: false, cwd: join(home, 'repos', project), sessionId: id, version: '2.1.322', gitBranch: 'main' };
    const path = join(dir, `${id}.jsonl`);
    writeFileSync(path, jsonl(entries.map(e => ({ ...base, ...e }))));
    const t = new Date(Date.now() - mtimeAgo * 1000);
    utimesSync(path, t, t);

    return dir;
}

// A subagent of the master: meta.json plus transcript under <session>/subagents/.
function agent(dir, id, meta, entries, mtimeAgo) {

    const sub = join(dir, IDS.master, 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', ...meta }));
    const path = join(sub, `${id}.jsonl`);
    writeFileSync(path, jsonl(entries.map(e => ({ isSidechain: true, sessionId: IDS.master, cwd: join(dir, 'x'), ...e }))));
    const t = new Date(Date.now() - mtimeAgo * 1000);
    utimesSync(path, t, t);
}

export function buildFixture(root) {

    const home = join(root, 'home'), bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });

    // git repos only so the server's `git remote get-url origin` names the project and its forge
    for (const [name, origin] of [['alpha', 'git@gitlab.com:acme/alpha.git'], ['beta', 'https://github.com/acme/beta.git'], ['gamma', 'git@gitlab.com:acme/gamma.git']]) {
        const repo = join(home, 'repos', name);
        mkdirSync(repo, { recursive: true });
        execFileSync('git', ['init', '-q', repo]);
        execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    }

    const stub = fileURLToPath(new URL('./forge-stub.mjs', import.meta.url));
    for (const cli of ['glab', 'gh']) {
        writeFileSync(join(bin, cli), `#!/bin/sh\nexec "${process.execPath}" "${stub}" ${cli} "$@"\n`, { mode: 0o755 });
    }

    const alpha = session(home, 'alpha', IDS.master, [
        { type: 'ai-title', aiTitle: 'Login work' },
        prompt('Fix the login redirect bug', 3000),
        said('**▸ Fix login · needs you**\nThe redirect drops the return URL. I need your call on the cookie scope before I change it.', 2990),
        done(2980),
        prompt('Use the narrow scope', 2900),
        tool('Bash', { command: 'git log -3' }, 2890, 'big'),
        result('big', 'x'.repeat(2_000_000), 2880), // bigger than the server's first tail read
        said('**▸ Fix login**\nDone, the redirect keeps the return URL now. Should I push the branch?', 2870),
        done(2860),
        prompt('yes', 2800),
        said('API Error: 529 Overloaded · please retry', 2790, { isApiErrorMessage: true }),
        prompt('continue', 2700),
        tool('Skill', { skill: 'review-gate', args: `!102 ${MR(102)}` }, 2690),
        said('**Verdict: ready** for !102 at commit bbb2222.\n\nTLDR: ready', 2680),
        done(2670),
        link(100, 2660), link(101, 2650), link(103, 2640),
        prompt('Draft the release notes', 200),
        said('**▸ Release**\nThe fix is merged and the notes are drafted.\n\nThe notes cover the login redirect, the CSV export and the audit log, with links to each MR.\n\nTLDR: Should I tag the release now or wait for QA?', 120),
        done(110)
    ], 110);

    session(home, 'beta', IDS.asker, [
        { type: 'pr-link', prUrl: 'https://github.com/acme/beta/pull/7', timestamp: ago(900) },
        prompt('Add SQLite support', 400),
        tool('AskUserQuestion', { questions: [{ question: 'Which database should be the default?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }, 390)
    ], 390);

    session(home, 'alpha', IDS.worker, [
        prompt('Refactor the session store', 60),
        tool('Bash', { command: 'npm test' }, 30),
        { type: 'queue-operation', operation: 'enqueue', content: 'also update the docs', timestamp: ago(20) }
    ], 1);

    session(home, 'gamma', IDS.gamma, [prompt('Tidy the README', 5000), said('Tidied.', 4990), done(4980)], 4980);
    session(home, 'alpha', IDS.other, [prompt('Look into the build cache', 6000), said('The cache is fine.', 5990), done(5980)], 5980);

    agent(alpha, 'agent-run', { description: 'Implement !101' }, [
        { type: 'user', timestamp: ago(500), message: { role: 'user', content: 'Fix the login redirect for !101' } },
        { ...tool('Edit', { file_path: '/x/src/login.js', old_string: 'a', new_string: 'b' }, 400, 'e1'), gitBranch: '5-fix-login' },
        result('e1', 'ok', 390),
        tool('Bash', { command: 'npm test' }, 10, 'pending')
    ], 5);
    agent(alpha, 'agent-ship', { description: 'Ship !102', finished: true }, [
        { type: 'user', timestamp: ago(1200), message: { role: 'user', content: 'Open the MR for the audit log' } },
        tool('SubagentHandback', { message: `Opened ${MR(102)}\n\nTLDR: shipped the audit log` }, 600)
    ], 600);
    agent(alpha, 'agent-stopped', { description: 'Investigate flaky test' }, [
        { type: 'user', timestamp: ago(1500), message: { role: 'user', content: 'Find out why the auth test is flaky' } },
        tool('Bash', { command: 'npm test -- auth' }, 1300, 'f1'),
        result('f1', 'FAIL auth.test.js', 1200)
    ], 1200);
    agent(alpha, 'agent-notes', { description: 'Write release notes', finished: true }, [
        { type: 'user', timestamp: ago(900), message: { role: 'user', content: 'Draft the release notes' } },
        tool('SubagentHandback', { message: 'Notes drafted in NOTES.md.\n\nTLDR: notes ready' }, 300)
    ], 300);

    return { home, bin };
}

// Appends an assistant reply to a session file, which makes it the most recently updated one.
export function touchSession(home, project, id, text) {
    const base = { isSidechain: false, cwd: join(home, 'repos', project), sessionId: id, version: '2.1.322', gitBranch: 'main' };
    appendFileSync(join(home, '.claude', 'projects', `-fx-${project}`, `${id}.jsonl`), jsonl([{ ...base, ...said(text, 0) }, { ...base, ...done(0) }]));
}
