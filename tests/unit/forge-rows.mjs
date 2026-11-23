import assert from 'node:assert/strict';
import { column, nextStep, workItems, rowAction, itemColumn, groupIssues, excerpt } from '../../server.mjs';
import { chatMessage } from '../../web/src/lib/issues.ts';
import { agent, glabMr } from './helpers.mjs';

// An error nobody gave a status is ours: the caller gets a fixed text, the detail (absolute paths) goes to the server's output.
{
    const { errorReply } = await import('../../server/security.mjs');
    const logged = [];
    const raw = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/.claude/projects/x/y.jsonl'"), { code: 'ENOENT' });
    const [status, text] = errorReply(raw, e => logged.push(e));
    assert.equal(status, 500);
    assert.ok(!/\/|ENOENT|someone/.test(text), text);
    assert.deepEqual(logged, [raw]);
    assert.deepEqual(errorReply(Object.assign(new Error('busy'), { status: 409 }), e => logged.push(e)), [409, 'busy'], 'deliberate refusals keep their text');
    assert.equal(logged.length, 1);

    // refusals that used to fall through with no status
    const { sendSteps, interrupt } = await import('../../server.mjs');
    assert.throws(() => sendSteps('s', ' \n'), e => e.status === 400 && e.message === 'empty message');
    await assert.rejects(interrupt('nope'), e => e.status === 400 && e.message === 'bad id');
    console.log('ok error replies');
}

{
    // an MR closed without merging is not "merged": its own group, and an issue whose only MR was closed starts afresh
    assert.equal(column('idle', { state: 'closed' }, true), 'closed');
    assert.equal(itemColumn({ state: 'closed' }, { status: 'running' }, true), 'closed');
    assert.equal(chatMessage({ iid: 10, st: 'todo', assignees: [{ username: 'a' }], mrs: [{ iid: 150, state: 'closed' }] }), 'Implement #10');
    assert.equal(chatMessage({ iid: 10, st: 'todo', assignees: [], mrs: [] }), 'Assign #10 to me first (it is unassigned), then implement it.');
    assert.equal(chatMessage({ iid: 10, st: 'doing', mrs: [{ iid: 150, state: 'closed' }, { iid: 151, state: 'open' }] }), 'Check on #10 and !151');
    console.log('ok closed MRs');
}

{
    // an issue somebody already works on is found in any chat of the project: by a work item (branch, title, MR issue) or a running or queued prompt
    const { issueWork } = await import('../../web/src/lib/board.ts');
    const sub = { key: 'agent-1', sessionId: 'a', title: 'Dark mode', branch: '7-dark-mode', column: 'doing' };
    const a = { id: 'a', status: 'idle', items: [sub] }, b = { id: 'b', status: 'working', now: 'refactor', queued: ['then take on #8'] };
    assert.deepEqual(issueWork('7', [b, a]), { sessionId: 'a', key: 'agent-1' });
    assert.deepEqual(issueWork('8', [a, b]), { sessionId: 'b', key: null });
    assert.equal(issueWork('70', [a, b]), null);
    assert.equal(issueWork('9', [a, b]), null);
    assert.equal(issueWork('7', [{ id: 'a', items: [{ ...sub, column: 'closed' }] }]), null, 'an MR closed without merging is no work on it');
    console.log('ok issue work');
}

{
    // a glab/gh failure as the kind the page words
    const { problemOf } = await import('../../server/forge.mjs');
    assert.equal(problemOf(null), null);
    assert.equal(problemOf(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })), 'missing');
    assert.equal(problemOf(Object.assign(new Error('Command failed'), { killed: true })), 'timeout');
    assert.equal(problemOf({ stderr: 'glab: 401 Unauthorized' }), 'auth');
    assert.equal(problemOf({ stderr: 'To get started with GitHub CLI, please run:  gh auth login' }), 'auth');
    assert.equal(problemOf({ stderr: 'glab: 429 {"message":{"error":"Too many requests"}}' }), 'rate');
    assert.equal(problemOf({ stderr: 'gh: API rate limit exceeded (HTTP 403)' }), 'rate');
    assert.equal(problemOf(new Error('glab: 500 Internal Server Error')), 'error');
    console.log('ok forge problems');
}

{
    // GitHub: a PR with merge conflicts is blocked, never "Approved — merge it"; PRs link to issues by title, closing keyword or branch
    const { ghPr } = await import('../../server/forge.mjs');
    const { ghLinks } = await import('../../server/milestones.mjs');
    const pr = { state: 'OPEN', title: 'T', body: '', reviewDecision: 'APPROVED', isDraft: false, headRefName: 'b', baseRefName: 'main', statusCheckRollup: [], mergeable: 'MERGEABLE' };
    const url = 'https://github.com/o/r/pull/3';
    assert.deepEqual([ghPr(pr, url).ready, ghPr(pr, url).blocked], [true, null]);
    const conflict = ghPr({ ...pr, mergeable: 'CONFLICTING' }, url);
    assert.deepEqual([conflict.ready, conflict.blocked, column('idle', conflict, true), rowAction(url, conflict, null, 'T').label], [false, 'conflict', 'needs-you', 'Rebase']);
    assert.doesNotMatch(nextStep(conflict, null), /merge it/);

    const pull = (number, o) => ({ number, html_url: `https://github.com/o/r/pull/${number}`, state: 'open', merged_at: null, title: `PR ${number}`, body: '', head: { ref: 'x' }, user: { login: 'ann' }, ...o });
    const links = ghLinks([pull(1, { title: '#7 - Dark mode' }), pull(2, { body: 'Fixes #8', state: 'closed', merged_at: '2026-01-01T00:00:00Z' }), pull(3, { head: { ref: '9-export' }, state: 'closed' }), pull(4, { title: 'Bump to v7' })]);
    assert.deepEqual(Object.keys(links), ['7', '8', '9']);
    assert.deepEqual([links[7][0].iid, links[7][0].state, links[7][0].author.username, links[8][0].state, links[9][0].state], [1, 'open', 'ann', 'merged', 'closed']);
    assert.equal(groupIssues([{ iid: 7, state: 'open', assignees: [] }], links).groups.doing.length, 1);
    console.log('ok github parity');
}

{
    // a project without milestones answers with the user's open issues instead of an empty state, whatever was picked before
    const { milestones, defaultMilestone } = await import('../../server/milestones.mjs');
    const { repoPaths, accountOf } = await import('../../server/account.mjs');
    const { swr, me } = await import('../../server/forge.mjs');
    const repo = { host: 'gitlab.nm.test', path: 'g/nm' }, who = { name: 'Me', username: 'me' };
    repoPaths.set('nm', repo);
    me.set(`${accountOf(repo)}:${repo.host}`, { at: Date.now(), value: who });
    swr.set('ms:nm', { at: Date.now(), value: [] });
    swr.set('issues:nm:mine', { at: Date.now(), value: groupIssues([{ iid: 3, state: 'open', assignees: [who] }]) });
    try {
        for (const pick of ['', 'none', 'mine']) {
            const d = await milestones('nm', pick);
            assert.deepEqual([d.reason, d.selected?.mine, d.selected?.groups.assigned.map(i => i.iid)], [null, true, [3]], `pick "${pick}"`);
        }
    } finally {
        repoPaths.delete('nm');
        ['ms:nm', 'issues:nm:mine'].forEach(k => swr.delete(k));
    }

    // no MR of mine in any milestone: the only one, else the next one due, else the last one that was
    const ms = (id, due) => ({ id, due });
    assert.equal(defaultMilestone([ms(1, null)], [], '2026-06-01').id, 1);
    assert.equal(defaultMilestone([ms(1, '2026-05-01'), ms(2, '2026-07-01'), ms(3, '2026-06-15'), ms(4, null)], [], '2026-06-01').id, 3);
    assert.equal(defaultMilestone([ms(1, '2026-05-01'), ms(2, '2026-04-01')], [], '2026-06-01').id, 1);
    assert.equal(defaultMilestone([ms(1, '2026-07-01'), ms(2, '2026-06-15')], [1], '2026-06-01').id, 1, 'the one my MRs are in wins');
    assert.equal(defaultMilestone([ms(1, null), ms(2, null)], [], '2026-06-01'), null);
    console.log('ok milestone defaults');
}

{
    // MR/PR and the forge's name are worded by the project's forge, from one place on each side
    const { forgeWords } = await import('../../server/forge.mjs');
    const { repoPaths } = await import('../../server/account.mjs');
    const core = await import('../../web/src/lib/forge.ts');
    repoPaths.set('ghp', { host: 'github.com', path: 'o/ghp' });
    try {
        assert.deepEqual([forgeWords('ghp').forge, forgeWords('ghp').mr, forgeWords('nope').mr, forgeWords('nope', 'https://github.com/o/r/pull/1').mr], ['GitHub', 'PR', 'MR', 'PR']);
        const gh = workItems([{ id: 's', project: 'ghp', prs: [{ url: 'https://github.com/o/ghp/pull/5', at: 1 }], agents: [agent('done', 4, { status: 'done', updated: 0 })] }], () => null, 0, new Map());
        assert.ok(gh.length && gh.every(i => !/\bMR\b/.test(i.next)), gh.map(i => i.next).join(' | '));
    } finally {
        repoPaths.delete('ghp');
    }
    assert.deepEqual([core.forgeWords('GitHub').mr, core.forgeWords('https://github.com/o/r/pull/1').forge, core.forgeWords(undefined).mr, core.forgeWords('GitLab').forge], ['PR', 'GitHub', 'MR', 'GitLab']);
    assert.equal(chatMessage({ iid: 3, st: 'doing', mrs: [{ iid: 7, state: 'open', url: 'https://github.com/o/r/pull/7' }] }), 'Check on #3 and PR #7');
    assert.equal(chatMessage({ iid: 3, st: 'closable', mrs: [{ iid: 7, state: 'merged', url: 'https://github.com/o/r/pull/7' }] }), 'Close #3, its PR #7 is merged');
    console.log('ok forge words');
}

{
    // an issue description's HTML is dropped from the card's excerpt, not half-stripped into noise
    assert.equal(excerpt('<p>Hello <b>you</b></p>\n<img src="x.png" <script>alert(1)</script> there'), 'Hello you alert(1) there');
    assert.equal(excerpt('<details><summary>Steps</summary>\n\n1. Open it\n</details>'), 'Steps 1. Open it');
    console.log('ok excerpt html');
}
{
    // a conflict is not hidden behind a review comment or a failing pipeline
    const base = { state: 'open', blocked: 'conflict' };
    assert.match(nextStep({ ...base, changes: true, unanswered: 1, unansweredBy: ['Ann'] }, null), /^Reply to Ann's comment.*conflict/);
    assert.match(nextStep({ ...base, changes: true }, null), /^Address review comments.*conflict/);
    assert.match(nextStep({ ...base, ci: 'failing' }, null), /^Pipeline failing.*conflict/);
    assert.equal(nextStep({ state: 'open', changes: true }, null), 'Address review comments');
    assert.equal(nextStep(base, null), 'Merge conflicts — rebase it');
    console.log('ok conflict beside comments');
}
{
    // approved with its pipeline still running is at the Approved stage, though not ready to merge yet
    const running = await glabMr({ head_pipeline: { status: 'running' } }, 131);
    assert.deepEqual([running.ready, running.approved], [false, true]);
    assert.equal((await glabMr({ detailed_merge_status: 'not_approved' }, 132)).approved, false);
    const url = 'https://gitlab.com/g/p/-/merge_requests/5';
    const row = st => workItems([{ id: 's', project: 'p', prs: [{ url, at: 1 }], agents: [] }], () => st, 0, new Map())[0];
    assert.deepEqual([row(running).stageLabel, row(running).column, row({ state: 'open' }).stageLabel], ['Approved', 'review', 'Review']);
    const { ghPr } = await import('../../server/forge.mjs');
    const gh = { state: 'OPEN', title: 'T', isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] };
    assert.deepEqual([ghPr({ ...gh, reviewDecision: 'APPROVED' }, 'https://github.com/o/r/pull/1').approved, ghPr({ ...gh, reviewDecision: '' }, 'https://github.com/o/r/pull/1').approved], [true, false]);
    console.log('ok approved stage');
}
