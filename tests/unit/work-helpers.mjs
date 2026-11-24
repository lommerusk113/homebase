// Work helpers in their own tmux (server/helpers.mjs) and the CLI that drives them (bin/homebase.mjs), with fake tmux and git.
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadHelpers, startHelper, closeHelper, parentOf, findHelper, helperView, writeToken, PER_PARENT, TOTAL, START_MS } from '../../server/helpers.mjs';
import { helpers, HELPER_RULE, tmuxSession } from '../../server/tmux.mjs';
import { callerTmux, parseArgs, readOut, wait } from '../../bin/homebase.mjs';
import { now } from './helpers.mjs';

const uuid = n => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;
const P = uuid(90), Q = uuid(91);
const parent = { id: P, cwd: '/x/alpha', project: 'alpha', tmux: 'cc-00000090' };
const fakes = () => {
    const tmuxCalls = [], gitCalls = [];
    let n = 0;
    return {
        tmuxCalls, gitCalls,
        opts: {
            tm: async args => { tmuxCalls.push(args); },
            git: async args => {
                gitCalls.push(args);
                return { stdout: args.includes('--show-toplevel') ? '/x/alpha\n' : args.includes('HEAD') ? 'abc123\n' : '' };
            },
            now, newId: () => uuid(++n), trust: async () => false, hex: () => 'beef'
        }
    };
};

// start: worktree from the parent's HEAD, own tmux, rule and model on the line, brief last after --
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-help-'));
    helpers.clear();
    const { tmuxCalls, gitCalls, opts } = fakes();
    const h = await startHelper(dir, parent, { brief: 'Do the thing', title: 'Add paste labels' }, opts);
    assert.deepEqual(gitCalls.at(-1), ['-C', '/x/alpha', 'worktree', 'add', '-b', 'helper/add-paste-labels-beef', '/x/alpha/.claude/worktrees/add-paste-labels-beef', 'abc123']);
    assert.deepEqual(tmuxCalls[0].slice(0, 6), ['new-session', '-d', '-s', 'cc-00000001', '-c', '/x/alpha/.claude/worktrees/add-paste-labels-beef']);
    const line = tmuxCalls[0].at(-1);
    assert.ok(line.includes(HELPER_RULE), 'helper rule appended');
    assert.ok(line.endsWith(`--model 'sonnet' -n 'Add paste labels' --session-id ${uuid(1)} -- 'Do the thing'`), line);
    assert.deepEqual([h.parent, h.branch, h.base, h.slug, h.closedAt], [P, 'helper/add-paste-labels-beef', 'abc123', 'add-paste-labels-beef', null]);
    // a resume keeps the rule and the model
    const resume = tmuxSession(h.id, h.cwd).at(-1);
    assert.ok(resume.includes(HELPER_RULE) && resume.includes(`--model 'sonnet' --resume ${h.id}`), resume);
    assert.ok(!tmuxSession(P, '/x').at(-1).includes(HELPER_RULE), 'a plain chat gets no helper rule');
    // no worktree: the parent's cwd, no git; given model, base and branch are used
    await startHelper(dir, parent, { brief: 'Look', title: 'Read only', worktree: false, model: 'haiku' }, opts);
    assert.equal(gitCalls.length, 3);
    assert.equal(tmuxCalls[1][5], '/x/alpha');
    await startHelper(dir, parent, { brief: 'x', title: 'T', base: 'origin/main', branch: 'feat/x' }, opts);
    assert.deepEqual(gitCalls.at(-1).slice(-3), ['feat/x', '/x/alpha/.claude/worktrees/t-beef', 'origin/main']);
    // bad input never reaches git or tmux
    for (const bad of [{ brief: '', title: 'T' }, { brief: 'x', title: '' }, { brief: 'x', title: 'a\nb' }, { brief: 'x', title: 'T', branch: '--force' }, { brief: 'x', title: 'T', model: 'a b' }]) {
        await assert.rejects(startHelper(dir, parent, bad, opts), { status: 400 });
    }
    assert.equal(tmuxCalls.length, 3);
    // saved: survives a restart
    helpers.clear();
    loadHelpers(dir);
    assert.equal(helpers.size, 3);
    assert.equal(findHelper('00000001').id, uuid(1));
    assert.equal(findHelper('add-paste-labels-beef').id, uuid(1));
    assert.throws(() => findHelper('nope'), { status: 404 });
}
console.log('ok helper start');

// limits: 4 running per parent, 8 in all; a closed one frees its place
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-help-'));
    helpers.clear();
    const { tmuxCalls, opts } = fakes();
    for (let i = 0; i < PER_PARENT; i++) {
        await startHelper(dir, parent, { brief: 'x', title: `t${i}`, worktree: false }, opts);
    }
    const err = await startHelper(dir, parent, { brief: 'x', title: 'one more', worktree: false }, opts).catch(e => e);
    assert.equal(err.status, 429);
    assert.equal(err.body.running.length, PER_PARENT);
    await closeHelper(dir, uuid(1), {}, opts);
    await startHelper(dir, parent, { brief: 'x', title: 'after close', worktree: false }, opts);
    for (let i = 0; i < TOTAL - PER_PARENT; i++) {
        await startHelper(dir, { ...parent, id: Q }, { brief: 'x', title: `q${i}`, worktree: false }, opts);
    }
    await assert.rejects(startHelper(dir, { ...parent, id: uuid(92) }, { brief: 'x', title: 'ninth', worktree: false }, opts), { status: 429 });
    // concurrent starts can't both pass the limit
    helpers.clear();
    const results = await Promise.allSettled(Array.from({ length: PER_PARENT + 2 }, (_, i) => startHelper(dir, parent, { brief: 'x', title: `c${i}`, worktree: false }, opts)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, PER_PARENT);
    assert.ok(tmuxCalls.length > 0);
}
console.log('ok helper limits');

// parent lookup: the caller's tmux names a Homebase chat that is no helper
{
    helpers.clear();
    const list = [parent, { id: uuid(1), tmux: 'cc-00000001' }];
    assert.equal(parentOf(list, 'cc-00000090').id, P);
    assert.throws(() => parentOf(list, 'main'), { status: 403 });
    assert.throws(() => parentOf(list, null), { status: 403 });
    helpers.set(uuid(1), { id: uuid(1), parent: P });
    assert.throws(() => parentOf(list, 'cc-00000001'), /helper does not start helpers/);
    // the CLI's side: the session of $TMUX_PANE, nothing outside tmux
    const calls = [];
    assert.equal(callerTmux({ TMUX_PANE: '%3' }, (cmd, args) => { calls.push([cmd, ...args]); return 'cc-00000090\n'; }), 'cc-00000090');
    assert.deepEqual(calls[0], ['tmux', 'display', '-p', '-t', '%3', '#{session_name}']);
    assert.equal(callerTmux({}, () => assert.fail('no tmux call')), null);
    assert.equal(callerTmux({ TMUX_PANE: '%3' }, () => { throw new Error('no server'); }), null);
    assert.deepEqual(parseArgs(['--title', 'A b', '--wait', 'x', '--model', 'opus']), { flags: { title: 'A b', wait: true, model: 'opus' }, words: ['x'] });
}
console.log('ok helper parent');

// close: only =cc-<id8>, worktree without --force, branch only via -d; a dirty worktree is kept and flagged
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-help-'));
    helpers.clear();
    const { tmuxCalls, gitCalls, opts } = fakes();
    const h = await startHelper(dir, parent, { brief: 'x', title: 'Fix it' }, opts);
    tmuxCalls.length = gitCalls.length = 0;
    assert.deepEqual(await closeHelper(dir, h.id, {}, { ...opts, now: now + 5 }), { id: h.id, worktree: 'removed', branch: 'deleted' });
    assert.deepEqual(tmuxCalls, [['kill-session', '-t', '=cc-00000001']]);
    assert.deepEqual(gitCalls, [['-C', '/x/alpha', 'worktree', 'remove', h.cwd], ['-C', '/x/alpha', 'branch', '-d', 'helper/fix-it-beef']]);
    assert.equal(helpers.get(h.id).closedAt, now + 5);
    const h2 = await startHelper(dir, parent, { brief: 'x', title: 'Dirty' }, opts);
    const git = async args => {
        throw Object.assign(new Error('failed'), { stderr: args.includes('remove') ? 'fatal: contains modified or untracked files\n' : 'error: not fully merged' });
    };
    const out = await closeHelper(dir, h2.id, {}, { ...opts, git, tm: async () => { throw new Error('no session'); } });
    assert.deepEqual(out, { id: h2.id, worktree: 'kept: fatal: contains modified or untracked files', branch: 'kept: not merged' });
    assert.ok(helpers.get(h2.id).closedAt && helpers.get(h2.id).kept);
    await assert.rejects(closeHelper(dir, 'cc-unknown', {}, opts), { status: 404 });
    // a failed tmux start takes back its fresh worktree and branch
    gitCalls.length = 0;
    await assert.rejects(startHelper(dir, parent, { brief: 'x', title: 'Boom' }, { ...opts, tm: async () => { throw new Error('tmux down'); } }), /tmux down/);
    assert.deepEqual(gitCalls.slice(-2).map(a => a.slice(2, 4)), [['worktree', 'remove'], ['branch', '-d']]);
}
console.log('ok helper close');

// what read/list/wait see
{
    helpers.clear();
    const h = { id: uuid(1), parent: P, title: 'T', at: now, closedAt: null, branch: 'helper/t' };
    const live = new Set(['cc-00000001']);
    const sess = extra => [{ id: uuid(1), status: 'idle', asking: false, needsYou: false, lastReply: 'Done.\nTLDR: all green', ...extra }];
    assert.deepEqual([helperView(h, [], live).status, helperView(h, [], live).done], ['starting', false]);
    assert.deepEqual([helperView(h, sess({ status: 'working' }), live).status, helperView(h, sess({ status: 'working' }), live).done], ['working', false]);
    assert.equal(helperView(h, sess({ status: 'waiting', asking: true }), live).done, false, 'asking: keep waiting');
    assert.equal(helperView(h, sess({ needsYou: true }), live).done, false, 'waits on the user: keep waiting');
    assert.deepEqual([helperView(h, sess(), live).done, helperView(h, sess(), live).tldr], [true, 'all green']);
    assert.equal(helperView(h, sess({ status: 'working' }), new Set()).status, 'exited');
    // just started: the live-tmux cache may not have its tmux yet, which is not an exit
    assert.deepEqual([helperView(h, [], new Set(), now + 2000).status, helperView(h, [], new Set(), now + 2000).done], ['starting', false]);
    assert.equal(helperView(h, [], new Set(), now + START_MS).status, 'exited');
    assert.equal(helperView({ ...h, closedAt: now }, sess(), live).status, 'closed');
    const v = helperView(h, sess(), live);
    assert.equal(readOut(v), '00000001  T  [idle]  helper/t\nTLDR: all green');
    assert.ok(readOut(v, true).endsWith('Done.\nTLDR: all green'));
    // the token file is owner-only
    const dir = mkdtempSync(join(tmpdir(), 'hb-help-'));
    writeToken(dir, 'secret');
    assert.equal(readFileSync(join(dir, 'token'), 'utf8'), 'secret');
    assert.equal(statSync(join(dir, 'token')).mode & 0o777, 0o600);
    helpers.clear();
}
console.log('ok helper view');

// wait: polls until one helper's turn ended, keeps going while it works or asks, prints what ended
{
    const states = { a: ['working', 'working', 'asking'], b: ['working', 'working', 'idle'] };
    let polls = 0;
    const printed = [];
    const get = async id => {
        const status = states[id][Math.min(polls, 2)];
        return { id: `${id}0000000`, title: id, status, done: status === 'idle', tldr: 'ok' };
    };
    const done = await wait(['a', 'b'], {}, { every: 1, get: async id => { const h = await get(id); if (id === 'b') { polls++; } return h; }, print: t => printed.push(t) });
    assert.deepEqual(done.map(h => h.title), ['b']);
    assert.equal(polls, 3, 'kept polling while working');
    assert.deepEqual(printed, ['b0000000  b  [idle]\nTLDR: ok']);
}
// wait: an idle helper whose sent prompt hasn't started a turn yet is not finished; it is once seen working, or once a reply
// newer than the wait shows up; a closed one returns at once
{
    const run = async (seq, t0 = 1000) => {
        let i = 0;
        const done = await wait(['h'], {}, { every: 1, now: () => t0, print: () => {}, get: async () => {
            const [status, replyAt = 500] = seq[Math.min(i++, seq.length - 1)];
            return { id: 'h0000000', title: 'h', status, replyAt, done: ['idle', 'waiting', 'closed', 'exited'].includes(status) };
        } });
        return [done[0].status, i];
    };
    assert.deepEqual(await run([['idle'], ['idle'], ['starting'], ['working'], ['idle']]), ['idle', 5], 'old idle and starting polls are not the end');
    assert.deepEqual(await run([['idle'], ['idle', 2000]]), ['idle', 2], 'a reply newer than the wait ends it');
    assert.deepEqual(await run([['closed']]), ['closed', 1]);
    assert.deepEqual(await run([['idle'], ['exited']]), ['exited', 2]);
}
console.log('ok helper wait');
