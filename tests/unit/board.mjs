import assert from 'node:assert/strict';
import { NEW_TMUX, mapNewProjects, startingProjects, pipelineOf, ciOf } from '../../server.mjs';
import { clearState, topicHue, TOPIC_HUES, pickChat, newerSession } from '../../public/chat.js';
import { keyAction, stepKey, cycleProject } from '../../public/keys.js';

{
    for (const ok of ['cc-new-league', 'cc-new-My_repo.v2', 'cc-new-a']) {
        assert.ok(NEW_TMUX.test(ok), ok);
    }
    for (const bad of ['cc-new-', 'cc-abcdef01', 'cc-new-.x', 'cc-new--x', 'cc-new-a b', 'cc-new-a;b', 'x-cc-new-a', 'cc-new-a\nb', '']) {
        assert.ok(!NEW_TMUX.test(bad), JSON.stringify(bad));
    }
    const live = [{ name: 'cc-new-league', path: '/p/league' }, { name: 'cc-new-other', path: '/p/other' }, { name: 'cc-aaaaaaaa', path: '/p/league' }];
    const ss = [{ id: 'bbbbbbbb-1', cwd: '/p/league', created: 5 }, { id: 'cccccccc-2', cwd: '/p/league', created: 9 }, { id: 'dddddddd-3', cwd: '/elsewhere', created: 1 }];
    const map = new Map();
    mapNewProjects(ss, live, map);
    assert.deepEqual([...map], [['bbbbbbbb-1', { tmux: 'cc-new-league' }]], 'the earliest session in the start dir; a different cwd or no match maps nothing');
    mapNewProjects(ss, live, map);
    assert.equal(map.size, 1, 'a tmux that is mapped already is left alone');
    const own = new Map();
    mapNewProjects(ss, [...live, { name: 'cc-bbbbbbbb', path: '/p/league' }], own);
    assert.deepEqual([...own], [['cccccccc-2', { tmux: 'cc-new-league' }]], 'a session with its own tmux is skipped');
    assert.deepEqual(startingProjects(ss, live), [{ tmux: 'cc-new-other', name: 'other', dir: '/p/other' }], 'only a cc-new tmux with no transcript in its folder is starting');
    // Open in an existing folder: its sessions from before the tmux started are not the new chat
    const opened = [{ name: 'cc-new-league', path: '/p/league', created: 7 }];
    const fresh = new Map();
    mapNewProjects(ss, opened, fresh);
    assert.deepEqual([...fresh], [['cccccccc-2', { tmux: 'cc-new-league' }]]);
    assert.deepEqual(startingProjects(ss, [{ ...opened[0], created: 10 }]).map(p => p.tmux), ['cc-new-league'], 'still starting while only older sessions are there');
}
console.log('ok new project tmux');

{
    const gl = { status: 'success', web_url: 'https://gl/p/1', finished_at: '2026-11-12T10:00:00Z', updated_at: '2026-11-12T10:01:00Z' };
    assert.deepEqual(pipelineOf(gl), { status: 'success', url: 'https://gl/p/1', at: '2026-11-12T10:00:00Z' });
    assert.deepEqual(pipelineOf({ status: 'running', web_url: 'u', updated_at: 't' }), { status: 'running', url: 'u', at: 't' });
    assert.equal(pipelineOf(undefined), null); // MR without a pipeline
    assert.equal(pipelineOf(null, [], 'pr'), null); // PR without checks
    const ok = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-11-12T09:00:00Z' };
    const skip = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED', completedAt: '2026-11-12T09:30:00Z' };
    const run = { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '', startedAt: '2026-11-12T09:10:00Z' };
    const ctxFail = { __typename: 'StatusContext', state: 'FAILURE', startedAt: '2026-11-12T08:00:00Z' };
    assert.deepEqual(pipelineOf(null, [ok, skip], 'https://gh/pull/1'), { status: 'success', url: 'https://gh/pull/1/checks', at: '2026-11-12T09:30:00Z' });
    assert.equal(pipelineOf(null, [ok, run], 'p').status, 'running');
    assert.equal(pipelineOf(null, [ok, run, ctxFail], 'p').status, 'failed');
    assert.equal(pipelineOf(null, [{ __typename: 'StatusContext', state: 'PENDING' }], 'p').status, 'running');
    assert.equal(ciOf({ status: 'failed' }), 'failing');
    assert.equal(ciOf({ status: 'pending' }), 'running');
    assert.equal(ciOf({ status: 'success' }), null);
    assert.equal(ciOf(null), null);
}
console.log('ok pipeline');

{
    // the tracker incident: an idle older session's metadata writes put it first by mtime; the chat must not jump to it
    const T = '/Users/b/tracker';
    const old = { id: 'f67f', project: 'tracker', cwd: T, created: 1 }, live = { id: 'e9c1', project: 'tracker', cwd: `${T}/frontend`, created: 2 };
    const wt = { id: 'wt', project: 'tracker', cwd: `${T}/.claude/worktrees/x`, created: 5 }, side = { id: 'sc', project: 'tracker', cwd: T, sidechain: true, created: 6 };
    assert.equal(pickChat([old, live], 'e9c1', 'other-project').id, 'e9c1', 'bound session sticks though another is newer');
    assert.equal(pickChat([old, live], null, 'gone').id, 'e9c1', 'unbound, no activity known: the later-created master');
    assert.equal(pickChat([wt, side, live], null, null).id, 'e9c1', 'worktree and subagent sessions are never auto-picked');
    assert.equal(pickChat([wt, live], 'wt', null).id, 'wt', 'an explicit pick of one still holds');
    const succ = { id: 'next', project: 'tracker', cwd: T, created: 3, clearedFrom: 'e9c1' };
    assert.equal(pickChat([succ, old, live], 'e9c1', null).id, 'next', 'a Homebase /clear successor takes over');
    assert.equal(pickChat([{ ...succ, clearedFrom: undefined }, old, live], 'e9c1', null).id, 'e9c1', 'a plain newer session does not');
    assert.equal(newerSession([wt, side, old, live], old).id, 'e9c1', 'newer master is offered');
    assert.equal(newerSession([wt, side, old, live], live), null, 'worktree/subagent sessions are not offered');
    assert.equal(newerSession([{ ...succ, project: 'other' }, live], live), null, 'other projects are not offered');
    // fresh profile, nothing bound: /api/sessions lists the idle f67f first (newer mtime), but e9c1 was active last
    const idle = { ...old, updated: 2000, lastActivity: 100 }, active = { ...live, updated: 1000, lastActivity: 900 };
    assert.equal(pickChat([idle, active], null, null).id, 'e9c1', 'unbound: latest real activity, not mtime');
    assert.equal(newerSession([idle, active], active), null, 'an idle older session is not offered as newer');
    console.log('ok chat binding');
}
{
    const topics = ['Chat topic headers', 'Attention colours', 'CI pills', 'Milestone empty states', 'ø', 'x'.repeat(500)];
    for (const t of topics) {
        const h = topicHue(t);
        assert.ok(Number.isInteger(h) && h >= 0 && h < TOPIC_HUES, t);
        assert.equal(topicHue(t), h, 'stable');
    }
    assert.ok(new Set(topics.map(topicHue)).size > 2, 'spreads over hues');
    console.log('ok topic hue');
}
assert.deepEqual(clearState(null), { at: 0, fresh: false });
assert.deepEqual(clearState(''), { at: 0, fresh: false }); // "Show" resets the key to ''
assert.deepEqual(clearState('1700000000000'), { at: 1700000000000, fresh: false }); // Clear view, old format
assert.deepEqual(clearState('{"at":1700000000000,"mode":"new"}'), { at: 1700000000000, fresh: true }); // New conversation
assert.deepEqual(clearState('junk'), { at: 0, fresh: false });
console.log('ok clear state');

const kev = (key, mods = {}) => ({ key, ...mods });
assert.equal(keyAction(kev('j')), 'next');
assert.equal(keyAction(kev('ArrowUp')), 'prev');
assert.equal(keyAction(kev(' ')), 'toggle');
assert.equal(keyAction(kev('Enter')), 'toggle');
assert.equal(keyAction(kev('/')), 'chat');
assert.equal(keyAction(kev('?', { shiftKey: true })), 'help');
assert.equal(keyAction(kev('p')), null);
assert.equal(keyAction(kev('p'), 'g'), 'project');
assert.equal(keyAction(kev('r')), 'refresh');
assert.equal(keyAction(kev('r', { metaKey: true })), null); // Cmd+R stays the browser's reload
assert.equal(keyAction(kev('j'), 'g'), 'next');
assert.equal(keyAction(kev('k', { metaKey: true })), null); // browser and OS shortcuts pass through
assert.equal(stepKey(['a', 'b', 'c'], 'b', 1), 'c');
assert.equal(stepKey(['a', 'b', 'c'], 'c', 1), 'c'); // clamps
assert.equal(stepKey(['a', 'b', 'c'], 'a', -1), 'a');
assert.equal(stepKey(['a', 'b', 'c'], null, 1), 'a');
assert.equal(stepKey(['a', 'b', 'c'], 'gone', -1), 'c');
assert.equal(stepKey([], 'a', 1), null);
assert.deepEqual(['n', '[', ']'].map(key => keyAction({ key }, null)), ['needs', 'prevProject', 'nextProject']);
assert.equal(cycleProject(['a', 'b', 'c'], 'c', 1), 'a'); // wraps
assert.equal(cycleProject(['a', 'b', 'c'], 'a', -1), 'c');
assert.equal(cycleProject(['a', 'b', 'c'], 'all', 1), 'a');
assert.equal(cycleProject(['a', 'b', 'c'], 'all', -1), 'c');
assert.equal(cycleProject([], 'all', 1), null);
console.log('ok keys');
