#!/usr/bin/env node
// homebase: the CLI a chat uses to run work helpers in their own chats (server/helpers.mjs). No dependencies.
// It talks to the running Homebase on localhost (HOMEBASE_PORT, default 4321) with the token from $HOMEBASE_DIR/token.
// The parent chat is the caller's own tmux session ($TMUX_PANE), never an argument.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const USAGE = `usage: homebase helper <command>
  start --title "<verb object>" [--model sonnet] [--base <ref>] [--branch <name>] [--no-worktree] [--wait]   (brief on stdin)
  read <id> [--full]
  list [--all]
  stop <id> [--keep-worktree]
  send <id>... | --all          (message on stdin)
  wait <id>...                  (returns when one ends a turn or closes, with its read output)
homebase status doing|needs-you|done [--mr <url or !N>] ["<what, e.g. Running tests>"]`;

const fail = (msg, code = 1) => {
    process.stderr.write(`${msg}\n`);
    process.exit(code);
};

// The caller's tmux session name (cc-<id8> for a Homebase chat); null outside tmux.
export function callerTmux(env = process.env, exec = execFileSync) {

    if (!env.TMUX_PANE) {
        return null;
    }
    try {
        return exec('tmux', ['display', '-p', '-t', env.TMUX_PANE, '#{session_name}'], { encoding: 'utf8' }).trim() || null;
    } catch {
        return null;
    }
}

// --flag value / --flag pairs and the positional words.
export function parseArgs(argv) {

    const flags = {}, words = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) {
            words.push(a);
        } else if (['--title', '--model', '--base', '--branch', '--mr'].includes(a)) {
            flags[a.slice(2)] = argv[++i];
        } else {
            flags[a.slice(2)] = true;
        }
    }

    return { flags, words };
}

async function api(path, { method = 'GET', body, env = process.env } = {}) {

    const dir = env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase');
    let token;
    try {
        token = readFileSync(join(dir, 'token'), 'utf8').trim();
    } catch {
        fail(`no token in ${dir}: is Homebase running?`);
    }
    const res = await fetch(`http://localhost:${env.HOMEBASE_PORT ?? 4321}${path}`, {
        method, body, headers: { 'x-homebase-token': token, ...(method === 'POST' && { 'x-codetool': '1' }) }
    }).catch(e => { throw Object.assign(new Error(`Homebase is not reachable: ${e.message}`), { unreachable: true }); });
    const text = await res.text();
    if (!res.ok) {
        let err = text;
        try {
            const j = JSON.parse(text);
            err = `${j.error}${j.running ? `\nrunning:\n${j.running.map(h => `  ${h.id.slice(0, 8)}  ${h.title}`).join('\n')}` : ''}`;
        } catch {}
        const e = new Error(err);
        e.status = res.status;
        throw e;
    }

    return text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
}

const age = ms => (ms < 3600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3600_000)}h`);

// read's output: status, topic, now/step, open question, then the TLDR (or the whole last reply with full).
export function readOut(h, full = false) {

    return [
        `${h.id.slice(0, 8)}  ${h.title}  [${h.status}]${h.branch ? `  ${h.branch}` : ''}`,
        h.topic && `topic: ${h.topic}`,
        h.now && `now: ${h.now}`,
        h.step && `step: ${h.step}`,
        h.status === 'asking' ? `${h.title} needs you: step into its row` : h.question && `question: ${h.question}`,
        h.kept && `worktree ${h.kept}`,
        full ? h.reply && `\n${h.reply}` : h.tldr && `TLDR: ${h.tldr}`
    ].filter(Boolean).join('\n');
}

const listOut = (h, now = Date.now()) => `${h.id.slice(0, 8)}  ${h.title}  [${h.status}]  ${h.branch ?? '(no worktree)'}${h.ahead != null ? ` +${h.ahead}` : ''}  ${age(now - h.at)}`;

const readStdin = async () => {
    let s = '';
    for await (const chunk of process.stdin) {
        s += chunk;
    }

    return s;
};

// Polls every `every` ms until a helper ends a turn without asking or waiting on the user, then prints the read output of each
// one that did. Run as a background command, its exit is the main chat's notice. A turn counts as ended only once the helper
// was seen at it (working, asking, needing you) or wrote a reply after the wait began, so an idle helper whose sent prompt
// hasn't started a turn yet doesn't read as finished; a closed or exited helper returns at once. A Homebase restart during the wait
// is retried quietly; only `patience` ms of unbroken failures end it.
export async function wait(ids, env = process.env, { every = 5000, patience = 120_000, get = id => api(`/api/helpers/${encodeURIComponent(id)}`, { env }), print = console.log, now = Date.now } = {}) {

    const began = now(), seen = new Set();
    let downSince = null;
    for (;;) {
        let all;
        try {
            all = await Promise.all(ids.map(get));
            downSince = null;
        } catch (e) {
            if (!e.unreachable || now() - (downSince ??= now()) > patience) {
                throw e;
            }
            await new Promise(r => setTimeout(r, every));
            continue;
        }
        all.filter(h => !h.done && h.status !== 'starting').forEach(h => seen.add(h.id));
        const done = all.filter(h => h.done && (seen.has(h.id) || h.replyAt > began || ['closed', 'exited'].includes(h.status)));
        if (done.length) {
            print(done.map(h => readOut(h)).join('\n\n'));
            return done;
        }
        await new Promise(r => setTimeout(r, every));
    }
}

export async function main(argv = process.argv.slice(2), env = process.env) {

    const [group, cmd, ...rest] = argv;
    if (!(group === 'helper' || group === 'status') || !cmd) {
        fail(USAGE, 2);
    }
    const { flags, words } = parseArgs(rest);
    const parent = callerTmux(env);
    const needParent = () => parent ?? fail('run this inside a Homebase chat: no tmux pane ($TMUX_PANE) found');
    const q = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== false).map(([k, v]) => [k, v === true ? '1' : v])).toString();

    // the chat's own row: which MR it works on and what it does, so the board never guesses that from its replies
    if (group === 'status') {
        if ('mr' in flags && !flags.mr) {
            fail(USAGE, 2); // --mr with no value: an unquoted #12 the shell read as a comment
        }
        await api(`/api/status?${q({ parent: needParent() })}`, { method: 'POST', body: JSON.stringify({ phase: cmd, mr: flags.mr ?? null, text: words.join(' ') || null }), env });
        console.log(`status: ${cmd}${flags.mr ? ` on ${flags.mr}` : ''}${words.length ? `: ${words.join(' ')}` : ''}`);
        return;
    }

    if (cmd === 'start') {
        if (!flags.title) {
            fail(USAGE, 2);
        }
        const h = await api(`/api/helpers/start?${q({ parent: needParent(), title: flags.title, model: flags.model, base: flags.base, branch: flags.branch, 'no-worktree': flags['no-worktree'] })}`, { method: 'POST', body: await readStdin(), env });
        console.log(`started ${h.id.slice(0, 8)} (${h.title})${h.branch ? ` on ${h.branch} in ${h.cwd}` : ` in ${h.cwd}`}; tmux attach -t cc-${h.id.slice(0, 8)}`);
        if (flags.wait) {
            await wait([h.id], env);
        }
        return h.id;
    }
    if (cmd === 'send') {
        const ids = flags.all ? (await api(`/api/helpers?${q({ parent: needParent() })}`, { env })).map(h => h.id) : words;
        if (!ids.length) {
            fail(flags.all ? 'no running helpers' : USAGE, flags.all ? 1 : 2);
        }
        const text = await readStdin();
        let failed = false;
        for (const id of ids) {
            try {
                await api(`/api/helpers/send?${q({ id, parent: needParent() })}`, { method: 'POST', body: text, env });
                console.log(`sent ${id.slice(0, 8)}`);
            } catch (e) {
                failed = true;
                console.log(`${id.slice(0, 8)}: not sent: ${e.message}`);
            }
        }
        process.exitCode = failed ? 1 : 0;
        return;
    }
    if (cmd === 'wait') {
        if (!words.length) {
            fail(USAGE, 2);
        }
        await wait(words, env);
        return;
    }
    if (cmd === 'read') {
        console.log(readOut(await api(`/api/helpers/${encodeURIComponent(words[0] ?? '')}`, { env }), !!flags.full));
        return;
    }
    if (cmd === 'list') {
        const list = await api(`/api/helpers?${q(flags.all ? { all: true } : { parent: needParent() })}`, { env });
        console.log(list.length ? list.map(h => listOut(h)).join('\n') : 'no helpers');
        return;
    }
    if (cmd === 'stop') {
        const out = await api(`/api/helpers/stop?${q({ id: words[0], 'keep-worktree': flags['keep-worktree'] })}`, { method: 'POST', env });
        console.log(`stopped ${out.id.slice(0, 8)}${out.worktree ? `; worktree ${out.worktree}; branch ${out.branch}` : ''}`);
        return;
    }
    fail(USAGE, 2);
}

// run directly or through a symlink on PATH; imported by the tests
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    main().catch(e => fail(e.message));
}
