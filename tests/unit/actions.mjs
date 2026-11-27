// MR buttons that start a fresh helper (server/actions.mjs): the brief, the owning chat, one helper per MR and action. Fake tmux and git only.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startActionHelper, actionBrief, owningChat, ACTIONS } from '../../server/actions.mjs';
import { helpers } from '../../server/tmux.mjs';
import { namesMr } from '../../server/forge.mjs';

const PR = 'https://gitlab.com/g/p/-/merge_requests/71';
const mr = { key: 'k', pr: PR, project: 'p', title: 'Add paste labels', source: '12-paste', target: 'main', sha: 'abc1234', sessionId: 'c1' };
const uuid = n => `${String(n).padStart(8, '0')}-2222-4333-8444-555555555555`;

// the brief names the MR and its job, and points at the owning chat's transcript only when there is one
for (const a of Object.keys(ACTIONS)) {
    const b = actionBrief(a, mr, '/h/.claude/projects/-x/c1.jsonl');
    for (const need of [PR, '!71', 'Add paste labels', '12-paste', 'main', 'CLAUDE.md', 'homebase status', 'Earlier discussion of this MR is in /h/.claude/projects/-x/c1.jsonl; read it']) {
        assert.ok(b.includes(need), `${a} brief has ${need}`);
    }
    assert.ok(!actionBrief(a, mr).includes('Earlier discussion'), `${a}: no chat, no path`);
}
assert.match(actionBrief('conflict', mr), /--force-with-lease=12-paste:abc1234 origin HEAD:12-paste/);
assert.match(actionBrief('failing', mr), /failed job/);
assert.match(actionBrief('changes', mr), /reply in each thread/);
assert.throws(() => actionBrief('nope', mr), /no such action/);
console.log('ok action briefs');

// the owning chat: the one on the MR's branch, else the row's own chat; a helper's chat gives way to its parent
{
    const list = [
        { id: 'c1', project: 'p', tmux: 'cc-c1', head: 'other', cwd: '/x/p' },
        { id: 'c2', project: 'p', tmux: 'cc-c2', head: '12-paste', cwd: '/x/p' },
        { id: 'h1', project: 'p', tmux: 'cc-h1', head: '12-paste', cwd: '/x/p/wt' }
    ];
    const reg = new Map([['h1', { id: 'h1', parent: 'c1', parentTmux: 'cc-c1' }]]);
    assert.equal(owningChat(list, mr, reg).id, 'c2', 'the chat on the branch, never a helper');
    assert.equal(owningChat(list.filter(s => s.id !== 'c2'), mr, reg).id, 'c1', 'else the row chat');
    assert.equal(owningChat(list, { ...mr, sessionId: 'h1', source: 'x' }, reg).id, 'c1', 'a helper chat gives way to its parent');
    assert.equal(owningChat([], mr, reg), null);
}
console.log('ok owning chat');

// start: worktree from origin/<source>, brief with the transcript, title naming the MR (nests under its row); a repeat opens the running one
{
    const dir = mkdtempSync(join(tmpdir(), 'hb-act-'));
    helpers.clear();
    const tmuxCalls = [], gitCalls = [], fetches = [];
    let n = 0;
    const opts = {
        fetchBranch: async (cwd, b) => { fetches.push([cwd, b]); },
        tm: async a => { tmuxCalls.push(a); },
        git: async a => { gitCalls.push(a); return { stdout: a.includes('--git-common-dir') ? '/x/p/.git\n' : '' }; },
        newId: () => uuid(++n), trust: async () => false, hex: () => 'beef', now: 1
    };
    const list = [{ id: uuid(90), project: 'p', tmux: 'cc-00000090', head: '12-paste', cwd: '/x/p', dir: '-x-p' }];
    const first = await startActionHelper(dir, mr, 'conflict', list, opts);
    assert.equal(first.existing, false);
    assert.deepEqual(fetches, [['/x/p', ['12-paste', 'main']]]);
    assert.deepEqual(gitCalls.at(-1).slice(2, 5), ['worktree', 'add', '-b']);
    assert.equal(gitCalls.at(-1).at(-1), 'origin/12-paste');
    assert.equal(first.helper.title, 'Rebase !71');
    assert.ok(namesMr(first.helper.title, PR), 'its title names the MR, so its row nests under the MR');
    assert.equal(first.helper.action, `conflict:${PR}`);
    assert.equal(first.helper.parent, uuid(90));
    assert.ok(tmuxCalls[0].at(-1).includes(`${uuid(90)}.jsonl`), 'the owning chat\'s transcript is in the brief');

    const again = await startActionHelper(dir, mr, 'conflict', list, opts);
    assert.deepEqual([again.existing, again.helper.id], [true, first.helper.id]);
    assert.equal(tmuxCalls.length, 1, 'a repeat starts nothing');
    const [a, b] = await Promise.all([startActionHelper(dir, mr, 'failing', list, opts), startActionHelper(dir, mr, 'failing', list, opts)]);
    assert.deepEqual([a.existing, b.existing].toSorted(), [false, true], 'two clicks at once start one');
    const other = await startActionHelper(dir, mr, 'changes', list, opts);
    assert.equal(other.existing, false, 'another action on the same MR is its own helper');

    helpers.get(first.helper.id).closedAt = 5;
    assert.equal((await startActionHelper(dir, mr, 'conflict', list, opts)).existing, false, 'a closed helper does not count');
    await assert.rejects(startActionHelper(dir, { ...mr, pr: `${PR}0`, source: null }, 'changes', list, opts), /no known source branch/);
    await assert.rejects(startActionHelper(dir, { ...mr, pr: `${PR}0` }, 'changes', [], opts), /no chat/);
}
console.log('ok action helper start');
