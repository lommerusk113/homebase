import assert from 'node:assert/strict';
import { workItems, issueOf, mentionsMr, turnPrompts, spawnPrompts, worksOnMr, requestFor } from '../../server.mjs';

{
    const url = 'https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1785';
    assert.equal(issueOf('#2219 - Auto booked creator', ''), '2219');
    assert.equal(issueOf('Auto booked creator', 'Some text.\n\nCloses #2219'), '2219');
    assert.equal(issueOf('Auto booked creator', null), null);
    // the row button's own message, a bare !N, the issue; not a longer number, an issue ref of the MR number, or &epic
    assert.equal(mentionsMr(`Address the review comments on !1785 (${url}), push, and reply in each thread.`, url, '2219'), true);
    assert.equal(mentionsMr('check !1785 again', url, null), true);
    assert.equal(mentionsMr('how is #2219 going?', url, '2219'), true);
    assert.equal(mentionsMr('look at !17850 and #22190', url, '2219'), false);
    assert.equal(mentionsMr('issue #1785 and &2219', url, '2219'), false);
    assert.equal(mentionsMr('look at #12', 'https://github.com/o/r/pull/12', null), true);

    // turn prompts, from real entry shapes: a typed turnPosition prompt and a human queued_command attachment
    const at = s => `2026-11-13T10:${s}.000Z`;
    const prompt = (s, text, extra = {}) => ({ type: 'user', isSidechain: false, uuid: s, timestamp: at(s), origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human', turnPosition: { promptIndex: 74, turnIndex: 136 }, message: { role: 'user', content: text }, ...extra });
    const queued = (s, text, kind = 'human') => ({ type: 'attachment', isSidechain: false, timestamp: at(s), attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind }, humanTurn: true } });
    const td = s => ({ type: 'system', subtype: 'turn_duration', timestamp: at(s) });
    const tool = s => ({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id: `t${s}`, name: 'Bash', input: {} }] } });
    const ask = prompt('12:00', `Address the review comments on !1785 (${url}), push, and reply in each thread.`);
    assert.deepEqual(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000).map(p => p.text.slice(0, 33)), ['Address the review comments on !1']);
    assert.deepEqual(turnPrompts([td('11:00'), ask, tool('12:05'), td('12:30')], 1_000), []);
    assert.deepEqual(turnPrompts([td('11:00'), prompt('12:00', 'unrelated'), queued('12:10', 'and #2219?'), queued('12:11', 'note', 'task-notification')], 1_000).map(p => p.text), ['unrelated', 'and #2219?']);
    // a turn a task notification started has no human prompt
    assert.deepEqual(turnPrompts([td('11:00'), prompt('12:00', '<task-notification>…</task-notification>', { origin: { kind: 'task-notification' } })], 1_000), []);
    // auto-compact mid-turn: the summary entry (turnPosition, isCompactSummary) keeps the turn's prompt
    const compacted = [td('11:00'), ask, tool('12:05'), { type: 'system', subtype: 'compact_boundary', timestamp: at('12:06') }, prompt('12:06', 'This session is being continued…', { isCompactSummary: true }), tool('12:07')];
    assert.deepEqual(turnPrompts(compacted, 1_000).map(p => p.at), [at('12:00')]);
    assert.deepEqual([...spawnPrompts([...compacted, { type: 'assistant', isSidechain: false, timestamp: at('12:08'), message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Agent', input: {} }] } }]).values()], [ask.message.content]);

    // requested: shown as doing without a button while the turn is open and no agent runs for it
    const pr = { state: 'open', changes: true, reviewers: ['Ann'], branch: '2219-auto-booked-creator', issue: '2219', title: '#2219 - Auto booked creator' };
    const master = (openPrompts, agents = []) => ({ id: 'm', project: 'pracsys', prs: [{ url, at: 1 }], agents, openPrompts });
    const one = (s, prOf = () => pr) => workItems([s], prOf, 0, new Map())[0];
    const req = one(master(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000)));
    assert.deepEqual([req.column, req.next, req.action, req.requested.at], ['doing', 'Sent to Claude…', null, at('12:00')]);
    const idle = one(master([]));
    assert.deepEqual([idle.column, idle.requested, idle.action.label], ['needs-you', null, 'Fix & reply']);
    // another project's session asking about the same number doesn't count
    assert.equal(requestFor([{ project: 'other', openPrompts: [{ at: at('12:00'), text: 'fix !1785' }] }], 'pracsys', url, pr), null);

    // agent linking: branch, issue in the description, issue/!N/URL in the prompt; done agents only by !N in the description
    const ag = extra => ({ id: 'a', status: 'running', stage: 1, updated: 5, prs: [], description: 'Implement thing', prompt: '', branches: ['worktree-agent-a'], ...extra });
    assert.equal(worksOnMr(ag({ branches: ['worktree-agent-a', '2219-auto-booked-creator'] }), url, pr), true);
    assert.equal(worksOnMr(ag({ description: 'Implement #2219 auto booked' }), url, pr), true);
    // a finished agent links a GitHub PR by #N in its description, as a GitLab one by !N
    const ghPr = 'https://github.com/o/r/pull/12';
    assert.deepEqual(['Address comments on #12', 'Address comments on #123', 'Address comments on !12'].map(d => worksOnMr(ag({ status: 'done', description: d }), ghPr, null)), [true, false, false]);
    assert.equal(worksOnMr(ag({ status: 'done', description: 'Rebase !1785' }), url, pr), true);
    // a helper titled "MR 1785 review fixes" (the main chat's name for it) works on the MR, so the row stays in Doing while it runs
    assert.deepEqual(['MR 1785 review fixes', 'PR 1785 review fixes', 'MR 17850 review fixes', 'XMR 1785 fixes'].map(d => worksOnMr(ag({ description: d, branches: [] }), url, pr)), [true, true, false, false]);
    assert.equal(one({ ...master([]), agents: [ag({ description: 'MR 1785 review fixes', branches: [], sessionId: 'm' })] }).column, 'doing');
    assert.equal(worksOnMr(ag({ prompt: 'Implement GitLab issue #2219 in pracsys' }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: `Fix the comments on ${url}` }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: 'Fix the comments on !1785' }), url, pr), true);
    assert.equal(worksOnMr(ag({ prompt: 'Implement #2220' }), url, pr), false);
    // only the prompt's first refs count: issues listed for context don't link
    assert.equal(worksOnMr(ag({ prompt: 'Implement issue #2220. Related: #2219 already shipped.' }), url, pr), false);
    assert.equal(worksOnMr(ag({ prompt: 'Simulate an accountant. Known bugs: #2217, #2218, #2219, #2220.' }), url, pr), false);
    assert.equal(worksOnMr(ag({ status: 'done', prompt: 'Implement #2219' }), url, pr), false);
    assert.equal(worksOnMr(ag({ status: 'done', description: 'Rebase !1785' }), url, pr), true);
    // a helper titled "MR 1785 review fixes" (the main chat's name for it) works on the MR, so the row stays in Doing while it runs
    assert.deepEqual(['MR 1785 review fixes', 'PR 1785 review fixes', 'MR 17850 review fixes', 'XMR 1785 fixes'].map(d => worksOnMr(ag({ description: d, branches: [] }), url, pr)), [true, true, false, false]);
    assert.equal(one({ ...master([]), agents: [ag({ description: 'MR 1785 review fixes', branches: [], sessionId: 'm' })] }).column, 'doing');
    // a running linked agent takes over from requested: its stage line, no button
    const linked = one(master(turnPrompts([td('11:00'), ask, tool('12:05')], 1_000), [ag({ description: 'Fix #2219 review' })]));
    assert.deepEqual([linked.column, linked.next, linked.action, linked.requested, linked.agentStatus], ['doing', 'Fix #2219 review is implementing…', null, null, 'running']);
    // no cross-project match: the same issue number and branch in another project's agent stays loose
    const cross = workItems([master([]), { id: 'o', project: 'other', prs: [], agents: [ag({ id: 'x', description: 'Implement #2219', branches: ['2219-auto-booked-creator'] })] }], () => pr, 0, new Map());
    assert.deepEqual(cross.map(i => [i.key, i.column]), [[url, 'needs-you'], ['x', 'doing']]);

    // spawn links, from real shapes: the master's Agent tool_use, its launch result, and the subagent meta's toolUseId
    const spawn = (s, id, description) => ({ type: 'assistant', isSidechain: false, timestamp: at(s), message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description, isolation: 'worktree', prompt: 'Run the review-gate skill.' } }] } });
    const launched = (s, id, agentId) => ({ type: 'user', isSidechain: false, timestamp: at(s), message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` }] }] } });
    const note = (s, agentId) => prompt(s, `<task-notification>\n<task-id>${agentId}</task-id>\n<output-file>/tmp/${agentId}.output</output-file>\n<status>completed</status>\n</task-notification>`, { origin: { kind: 'task-notification' } });
    const url2 = 'https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1784';
    const spawns = spawnPrompts([
        td('11:00'), prompt('12:00', `Run review-gate on !1785 (${url}). If ready, merge it.`), spawn('12:01', 'toolu_gate', 'Gate: code review'), launched('12:02', 'toolu_gate', 'agate'), td('12:03'),
        prompt('13:00', 'Merge !1784 and !1785'), spawn('13:01', 'toolu_both', 'Merge both'), td('13:02'),
        prompt('14:00', 'Tidy the README'), spawn('14:01', 'toolu_other', 'Gate: rules compliance'), td('14:02'),
        note('15:00', 'agate'), spawn('15:01', 'toolu_merge', 'Merge after the gate'), td('15:02')
    ]);
    assert.deepEqual([...spawns.keys()], ['toolu_gate', 'toolu_both', 'toolu_other', 'toolu_merge']);
    assert.equal(spawns.get('toolu_merge'), spawns.get('toolu_gate')); // a task-notification turn inherits the notifying agent's prompt
    const gateAgent = (toolUseId, extra) => ag({ description: 'Gate: code review', prompt: 'Review the diff in the worktree.', spawnedFor: spawns.get(toolUseId), ...extra });
    assert.equal(worksOnMr(gateAgent('toolu_gate'), url, pr), true);
    assert.deepEqual([url, url2].map(u => worksOnMr(gateAgent('toolu_both'), u, { ...pr, issue: null })), [true, true]);
    assert.equal(worksOnMr(gateAgent('toolu_other'), url, pr), false);
    assert.equal(worksOnMr(gateAgent('toolu_gate', { status: 'done' }), url, pr), false);
    // the master's turn has ended, yet the MR stays doing while the gate it spawned runs
    const ready = { ...pr, changes: false, ready: true };
    const gated = one(master([], [gateAgent('toolu_gate')]), () => ready);
    assert.deepEqual([gated.column, gated.next, gated.action, gated.agentStatus], ['doing', 'Gate: code review is implementing…', null, 'running']);
    assert.equal(one(master([], [gateAgent('toolu_other')]), () => ready).action.label, 'Run gate');
    console.log('ok requested, agent links');
}
