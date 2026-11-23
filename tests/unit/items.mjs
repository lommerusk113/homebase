import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextStep, workItems, tmuxArgs, repoName, rowAction, gateRuns, gateFor, toGate, sameRepo } from '../../server.mjs';
import { loadStore, record, seeds, flush } from '../../server/store.mjs';
import { open, mr, agent } from './helpers.mjs';

assert.equal(nextStep({ state: 'merged' }, { status: 'running', stage: 1 }), 'Merged');
assert.equal(nextStep(open(), { status: 'running', stage: 2, description: 'Rebase !7' }), 'Rebase !7 is verifying…');
assert.equal(nextStep(open(), { status: 'running', stage: 2, description: 'Rebase !7', step: 'running unit tests' }), 'running unit tests');
{
    const { stepOf } = await import('../../server.mjs');
    assert.equal(stepOf({ name: 'Bash', input: { command: 'npm test\nmore' } }), 'running unit tests');
    const { plainCommand } = await import('../../web/src/lib/text.ts');
    assert.deepEqual([
        'while pgrep -f "run.mjs" >/dev/null; do sleep 5; done', 'node tests/browser/run.mjs', 'node test.mjs', './check-types.sh', 'git rebase main', 'git push origin x',
        "sed -i '' 's/a/b/' public/app.js", 'cat server/items.mjs', 'rg foo', 'git grep x', 'glab mr list', 'curl -s x', 'until grep -q "passed" /tmp/log; do sleep 2; done',
        'python3 - <<\'EOF\'', 'zsh /private/tmp/x/run-it.sh', 'cd /r && git commit -m x', 'node shot.mjs --screenshot'
    ].map(plainCommand), [
        'waiting for browser tests', 'running browser tests', 'running unit tests', 'type-checking', 'rebasing', 'pushing',
        'editing app.js', 'reading items.mjs', 'searching', 'searching', 'calling GitLab', 'calling an API', 'waiting',
        'running python', 'running run-it.sh', 'committing', 'taking screenshots'
    ]);
    assert.equal(stepOf({ name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } }), 'run the unit tests');
    assert.equal(stepOf({ name: 'Edit', input: { file_path: '/x/src/login.js' } }), 'editing login.js');
    assert.equal(stepOf({ name: 'mcp__x__y', input: {} }), 'using mcp__x__y');
}
assert.equal(nextStep(null, { status: 'stopped' }), 'Agent stopped — check the chat');
assert.equal(nextStep(null, { status: 'stopped', stopReason: 'api-error' }), 'Agent hit an API error — continue it');
assert.equal(nextStep(open({ changes: true, reviewers: ['Ann'] }), null), 'Address review comments from Ann');
assert.equal(nextStep(open({ changes: true, reviewers: ['Ann'], changesBy: ['bob'] }), null), 'Address review comments from bob');
assert.equal(nextStep(open({ reviewers: ['Ann', 'Bo'] }), { status: 'done' }), 'Waiting for review by Ann, Bo');
assert.equal(nextStep(open(), null), 'Needs a reviewer');
assert.equal(nextStep(open({ ready: true }), null), 'Approved — merge it');
assert.equal(nextStep(open({ ci: 'failing' }), null), 'Pipeline failing');
assert.equal(nextStep(open({ ci: 'running' }), null), 'Pipeline running');
assert.equal(nextStep(open({ draft: true }), null), 'Draft — mark it ready for review');
console.log('ok next');

const items = workItems([
    { id: 's1', project: 'p', prs: [{ url: mr(1), at: 10 }, { url: mr(2), at: 20 }], agents: [
        agent('impl1', 5, { prs: [mr(1)], tldr: 'old' }),
        agent('fix1', 30, { description: 'Address comments on !1', tldr: 'new' }),
        agent('sim', 40, { description: 'Simulate accountant' }),
        agent('wip', 50, { status: 'running', stage: 1, description: 'Implement #9' })
    ] },
    { id: 's2', project: 'p', prs: [{ url: mr(2), at: 25 }], agents: [] }
], url => (url === mr(1) ? { state: 'merged', title: 'One' } : open({ reviewers: ['Ann'] })));
assert.deepEqual(items.map(i => [i.key, i.sessionId, i.column, i.stageLabel, i.updated]), [
    [mr(1), 's1', 'done', 'Merged', 30],
    [mr(2), 's2', 'review', 'Review', 25],
    ['wip', 's1', 'doing', 'Implement', 50]
]);
assert.deepEqual([items[0].title, items[0].tldr, items[0].activity.map(x => x.id)], ['One', 'new', ['impl1']]);
assert.equal(items[1].next, 'Waiting for review by Ann');
// tracker "Build faction perks simulator": done without an MR stays visible for 2 h as "finished", then drops
const perks = now => workItems([{ id: 'm', project: 'tracker', prs: [], agents: [agent('perks', 0, { description: 'Build faction perks simulator' })] }], () => null, now);
assert.deepEqual(perks(3600_000).map(i => [i.key, i.column, i.next]), [['perks', 'finished', 'Finished without an MR']]);
assert.deepEqual(perks(3 * 3600_000), []);
// a row renamed by SendMessage keeps its spawn description as the tooltip
assert.deepEqual(workItems([{ id: 'm', project: 'p', prs: [], agents: [agent('r', 0, { description: 'Also rebase', firstDescription: 'Fix login' })] }], () => null, 0)
    .map(i => [i.title, i.firstTitle]), [['Also rebase', 'Fix login']]);
const one = prOf => workItems([{ id: 's', project: 'p', prs: [{ url: mr(5), at: 1 }], agents: [] }], prOf, 0, new Map())[0];
assert.equal(one(() => open({ ready: true })).stageLabel, 'Approved');
assert.deepEqual((({ column, stageLabel, next }) => [column, stageLabel, next])(one(() => ({ state: 'closed' }))), ['closed', 'Closed', 'Closed without merging']);
const verifying = workItems([{ id: 's', project: 'p', prs: [], agents: [agent('v', 1, { status: 'running', stage: 2 })] }], () => null, 0, new Map());
assert.deepEqual(verifying.map(i => i.stageLabel), ['Verify']);
// forge-seeded MRs: deduped against transcript URLs, bound to the project's newest session, others' projects untouched
const forged = workItems([
    { id: 'old', project: 'p', updated: 1, prs: [{ url: mr(1), at: 5 }], agents: [] },
    { id: 'new', project: 'p', updated: 9, prs: [], agents: [] },
    { id: 'q', project: 'q', updated: 99, prs: [], agents: [] }
], () => open(), 0, new Map(), [{ url: mr(1), project: 'p' }, { url: mr(7), project: 'p' }, { url: mr(7), project: 'p' }]);
assert.deepEqual(forged.map(i => [i.key, i.sessionId, i.column]), [[mr(1), 'old', 'review'], [mr(7), 'new', 'review']]);
// a stopped agent retried by a later one with the same description no longer offers Continue on the MR
{
    const review = () => ({ state: 'open', reviewers: ['Ann'], issue: '7', branch: 'b7' });
    const desc = 'Implement #7 confirm';
    const [row] = workItems([{ id: 's', project: 'p', prs: [{ url: mr(70), at: 1 }], agents: [
        agent('dead', 10, { status: 'stopped', stopReason: 'api-error', description: desc }),
        agent('retry', 20, { description: desc })
    ] }], () => review(), 30, new Map());
    assert.equal(row.agentStatus, null);
    assert.equal(row.next, 'Waiting for review by Ann');
}

console.log('ok items');

{
    const dir = mkdtempSync(join(tmpdir(), 'hb-store-'));
    const file = join(dir, 'items.json');
    const DAY = 864e5;
    const item = (url, prState, extra) => ({ pr: url, project: 'p', title: 't', sessionId: 's1', branch: 'b', prState, agentLinks: [{ id: 'a1', description: 'Impl !1', finished: 5 }], ...extra });

    // round trip: written once (mode 0600, no temp left), read back, throttled, and lastSeen alone is no change
    const st = loadStore(file);
    record(st, [item(mr(1), { state: 'open', title: 'One', issue: '9' }), item(mr(2), { state: 'merged' })], 1000);
    flush(st, 20_000);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ['items.json']);
    const back = loadStore(file);
    assert.deepEqual(back.data.p[mr(1)], { title: 'One', issue: '9', branch: 'b', sessionId: 's1', firstSeen: 1000, lastSeen: 1000, state: 'open', mergedAt: null, agents: [{ id: 'a1', description: 'Impl !1', finished: 5 }] });
    assert.equal(back.data.p[mr(2)].mergedAt, 1000);
    record(back, [item(mr(1), { state: 'open', title: 'One', issue: '9' })], 2000);
    assert.equal(back.dirty, false);
    record(back, [item(mr(1), { state: 'merged' })], 3000);
    assert.equal(back.dirty, true);
    flush(back, 25_000); // within 10 s of nothing written yet by this store: writes
    back.dirty = true;
    const before = readFileSync(file, 'utf8');
    record(back, [item(mr(1), { state: 'merged' }, { branch: 'other' })], 26_000);
    flush(back, 26_000 + 5000);
    assert.equal(readFileSync(file, 'utf8'), before, 'throttled to one write per 10 s');

    // seeding: open ones, and merged ones only within the window
    assert.deepEqual(seeds(loadStore(file), 4000, 3 * DAY).map(s => [s.url, s.sessionId, s.agents.length]).sort(), [[mr(1), 's1', 1], [mr(2), 's1', 1]]);
    assert.deepEqual(seeds(loadStore(file), 4000 + 4 * DAY, 3 * DAY), []);

    // pruning: entries the forge hasn't confirmed for 30 days go, open ones too (an MR it can't read any more stays
    // seeded forever otherwise); an open one it still answers for stays
    const old = loadStore(file);
    record(old, [item(mr(3), { state: 'open' }), item(mr(5), { state: 'open' })], 1000);
    record(old, [item(mr(5), null), item(mr(3), { state: 'open' })], 1000 + 31 * DAY);
    assert.deepEqual(Object.keys(old.data.p), [mr(3)]);

    // two Homebase instances on one file keep each other's entries; a pruned one doesn't come back from disk
    rmSync(file);
    const a = loadStore(file), b = loadStore(file);
    record(a, [item(mr(6), { state: 'open' })], 50_000);
    flush(a, 50_000);
    record(b, [item(mr(7), { state: 'open' })], 60_000);
    flush(b, 60_000);
    assert.deepEqual(Object.keys(loadStore(file).data.p).sort(), [mr(6), mr(7)]);
    assert.deepEqual(readdirSync(dir).sort(), ['items.json']);
    record(b, [], 60_000 + 31 * DAY);
    b.writtenAt = 0;
    flush(b, 60_000 + 31 * DAY);
    assert.equal(loadStore(file).data.p, undefined);

    // corrupt file: starts empty and keeps a .bak
    writeFileSync(file, '{"p": ');
    const bad = loadStore(file);
    assert.deepEqual(bad.data, {});
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"p": ');
    rmSync(dir, { recursive: true });

    // a stored MR no transcript mentions any more still seeds its row, with its finished agent and its session
    const kept = workItems([{ id: 's1', project: 'p', updated: 1, prs: [], agents: [] }, { id: 's2', project: 'p', updated: 9, prs: [], agents: [] }], () => open(), 0, new Map(),
        [{ url: mr(8), project: 'p', sessionId: 's1', agents: [{ id: 'gone', description: 'Impl !8', finished: 7 }] }]);
    assert.deepEqual(kept.map(i => [i.key, i.sessionId, i.agentStatus, i.updated]), [[mr(8), 's1', 'done', 7]]);
}
console.log('ok store');

assert.deepEqual(tmuxArgs(['send-keys', '-t', 'cc-1', 'Escape'], undefined), ['send-keys', '-t', 'cc-1', 'Escape']);
assert.deepEqual(tmuxArgs(['has-session'], 'hbtest'), ['-L', 'hbtest', 'has-session']);
console.log('ok tmux socket');

assert.equal(repoName('github-personal:lommerusk113/homebase.git\n'), 'homebase');
assert.equal(repoName('git@gitlab.com:tritt/accounting/pracsys.git'), 'pracsys');
assert.equal(repoName('https://github.com/contaas/portal-frontend'), 'portal-frontend');
console.log('ok repo name');
const act = (prState, agent, url = mr(4)) => rowAction(url, prState, agent, 'T');
assert.deepEqual(act(open({ ready: true, reviewers: ['Ann'] }), null), { label: 'Merge + close issue', message: `Run review-gate on !4 (${mr(4)}). If the verdict is ready, merge it and close its issue. If it's fix first, show me the findings and don't merge.` });
assert.equal(act(open({ ready: true }), null, 'https://github.com/o/r/pull/9').message.slice(0, 63), 'Run review-gate on #9 (https://github.com/o/r/pull/9). If the v');
assert.deepEqual(act(open({ changes: true, reviewers: ['Ann'] }), null), { label: 'Fix & reply', message: `Address the review comments on !4 (${mr(4)}), push, and reply in each thread.` });
// one precedence with nextStep: a stopped agent wins over the MR's own ask, but not over a merged MR; a running pipeline asks nothing
assert.deepEqual([open({ changes: true }), open({ ready: true })].map(p => act(p, { status: 'stopped' }).label), ['Continue', 'Continue']);
assert.equal(nextStep(open({ ready: true }), { status: 'stopped' }), 'Agent stopped — check the chat');
assert.equal(act({ state: 'merged' }, { status: 'stopped' }), null);
assert.equal(act(open({ ci: 'running' }), null), null);
assert.deepEqual(act(open({ ci: 'failing', reviewers: ['Ann'] }), null), { label: 'Fix pipeline', message: `The pipeline on !4 (${mr(4)}) is failing — find out why and fix it.` });
assert.deepEqual(act(open(), { status: 'done' }), { label: 'Request review', message: `Assign a reviewer to !4 (${mr(4)}) — suggest who.` });
assert.equal(act(open(), null, 'https://github.com/o/r/pull/9').message, 'Assign a reviewer to #9 (https://github.com/o/r/pull/9) — suggest who.');
assert.deepEqual(rowAction(null, null, { status: 'stopped' }, 'Implement #9'), { label: 'Continue', message: "The subagent 'Implement #9' stopped — check why and continue it." });
assert.equal(rowAction(null, null, { status: 'running' }, 'x'), null); // doing
assert.equal(act(open({ ready: true }), { status: 'running' }), null); // doing
assert.equal(act(open({ reviewers: ['Ann'] }), null), null); // waiting on review
assert.equal(act({ state: 'merged' }, null), null);
assert.equal(act(open({ draft: true }), null)?.label, 'Mark ready', 'a draft in Needs you has its button');
assert.equal(act(open({ draft: true, ci: 'running' }), null), null);
assert.equal(act(null, null), null); // state unknown

// shapes as in real transcripts: Skill tool_use { skill, args }, the skill's report as later assistant text
const said = (ts, ...content) => ({ type: 'assistant', timestamp: ts, message: { content } });
const skill = (name, args) => ({ type: 'tool_use', id: 'toolu_01', name: 'Skill', input: { skill: name, args } });
const txt = text => ({ type: 'text', text });
const gateTail = [
    said('2026-11-13T10:00:00Z', txt('**ready** to go, I think')), // before any gate: ignored
    said('2026-11-13T10:01:00Z', skill('review-gate', `!4 ${mr(4)}`)),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'Launching skill: review-gate' }] } },
    said('2026-11-13T10:02:00Z', txt('Running code-review and threat-review as subagents.')),
    said('2026-11-13T10:03:00Z', txt('The diff is **ready** for the reviewers.')), // a bold ready while the gate runs is no verdict
    said('2026-11-13T10:09:00Z', txt('**Verdict: fix first** — adds the gate badge\n\n| # | Sev |\n\n**TLDR:** **Fix first**: one HIGH on !4, fix the null check.')),
    said('2026-11-13T11:00:00Z', skill('review-gate', 'branch kjn-gate at commit abc1234')),
    said('2026-11-13T11:05:00Z', txt('Verdict: **ready** — clean.\nTLDR: **ready**, open it.'))
];
const runs = gateRuns(gateTail);
assert.deepEqual(runs.map(r => [r.verdict, r.at, r.tldr, r.commit]), [
    ['fix first', Date.parse('2026-11-13T10:09:00Z'), '**Fix first**: one HIGH on !4, fix the null check.', null],
    ['ready', Date.parse('2026-11-13T11:05:00Z'), '**ready**, open it.', 'abc1234']
]);
assert.deepEqual(gateRuns([said('t', skill('code-review', '!4')), said('t', txt('**Verdict: ready**'))]), []); // other skills don't arm
// real phrasings of the verdict
assert.deepEqual(['the verdict is **fix first**, so', 'Verdict was **ready**, with', 'review-gate is **ready**. Merge', '**Review gate verdict: ready.**']
    .map(t => gateRuns([said('t', skill('review-gate', '!4')), said('t', txt(t))])[0]?.verdict), ['fix first', 'ready', 'ready', 'ready']);
// a subagent briefed with review-gate reports through its handback
const handback = said('2026-11-13T12:00:00Z', { type: 'tool_use', name: 'SubagentHandback', input: { message: '**Verdict: ready** — fine\n\n**TLDR:** **ready** for review, open !7.' } });
assert.equal(gateRuns([handback], 'Run review-gate on the branch').at(0).verdict, 'ready');
assert.deepEqual(gateRuns([handback], 'Implement the badge'), []);
// a batch gate over several MRs: each MR gets the verdict its own line names, none when its verdict can't be told apart
{
    const batch = gateRuns([said('2026-11-13T13:00:00Z', { type: 'tool_use', name: 'SubagentHandback', input: { message: '!101 verdict: ready at commit abc1234\n!102 verdict: fix first\n!103 and !104 verdict: fix first\n\nTLDR: one ready.' } })],
        'Review-gate supplier MRs batch A\nRun review-gate on !101, !102, !103 and !104, one after the other.');
    assert.deepEqual([101, 102, 103, 104].map(n => toGate(gateFor(batch, mr(n), null), null)?.verdict), ['ready', 'fix first', undefined, undefined]);
    assert.deepEqual([gateFor(batch, mr(101), null).commit, gateFor(batch, mr(102), null).commit], ['abc1234', null]);
    // verdicts reported one message at a time keep counting
    const later = gateRuns([said('t1', skill('review-gate', '!5 and !6')), said('t2', txt('!5 verdict: **ready**')), said('t3', txt('!6 — Verdict: fix first'))]);
    assert.deepEqual([5, 6].map(n => gateFor(later, mr(n), null)?.verdict), ['ready', 'fix first']);
}
// association: URL, !N (not !40 or a path), branch
assert.equal(gateFor(runs, mr(4), 'x'), runs[0]);
assert.equal(gateFor(runs, mr(9), 'kjn-gate'), runs[1]);
assert.equal(gateFor(runs, mr(40), 'other'), null);
assert.equal(gateFor([{ text: 'see #9', at: 1 }], 'https://github.com/o/r/pull/9', null).at, 1);
// staleness: commit from the report, else the head first seen with the run
assert.equal(toGate(runs[1], 'abc1234ffff').stale, false);
assert.equal(toGate(runs[1], 'def5678ffff').stale, true);
const heads = new Map();
assert.equal(toGate(runs[0], 'aaa111', heads).stale, false);
assert.deepEqual(toGate(runs[0], 'bbb222', heads), { verdict: 'fix first', at: runs[0].at, tldr: runs[0].tldr, commit: null, stale: true });
assert.equal(toGate(null, 'x'), null);
const gated = workItems([{ id: 's', project: 'p', prs: [{ url: mr(4), at: 1 }], gates: runs, agents: [] }], () => open({ ready: true, sha: 'abc' }), 0, new Map());
assert.equal(gated[0].gate.verdict, 'fix first');
console.log('ok review gate');
assert.equal(items[1].action.label, 'Review'); // waiting on review: the reviewer chat's button (review-chat.mjs)
console.log('ok actions');

assert.equal(sameRepo('https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1590', 'pracsys'), true);
assert.equal(sameRepo('https://gitlab.com/tritt/accounting/pracsys/-/merge_requests/1590', 'homebase'), false);
assert.equal(sameRepo('https://github.com/lommerusk113/homebase/pull/3', 'homebase'), true);
console.log('ok same repo');

// a dismissed row without an MR stays away, on disk too, until its helper moves again; an MR's row is never dismissed
{
    const { loadDismissed, dismiss } = await import('../../server/dismissed.mjs');
    const dir = join(mkdtempSync(join(tmpdir(), 'hb-dismissed-')), 'homebase');
    const rows = (a, prs = []) => workItems([{ id: 's', project: 'p', prs, agents: [a] }], () => open(), 2000, new Map()).map(i => i.key);
    const stopped = agent('helper-1', 1000, { status: 'stopped' });
    assert.deepEqual(rows(stopped), ['helper-1']);

    for (const key of [mr(5), '../x', '', null, 'a b', 'x'.repeat(129)]) {
        await assert.rejects(dismiss(dir, key), e => e.status === 400, String(key));
    }
    assert.deepEqual(rows(stopped), ['helper-1'], 'a refused key dismisses nothing');

    await dismiss(dir, 'helper-1', 1500);
    assert.deepEqual(rows(stopped), [], 'gone');
    assert.deepEqual(rows(agent('other', 1000, { status: 'stopped' })), ['other'], 'only that row');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'dismissed.json'), 'utf8')), [['helper-1', 1500]]);
    loadDismissed(join(dir, 'none'));
    assert.deepEqual(rows(stopped), ['helper-1'], 'nothing saved there');
    loadDismissed(dir);
    assert.deepEqual(rows(stopped), [], 'another server start reads it back');

    // a new message resumed it: back while it runs, and it stays once it stops again
    assert.deepEqual(rows({ ...stopped, status: 'running', updated: 1600 }), ['helper-1']);
    assert.deepEqual(rows({ ...stopped, updated: 1600 }), ['helper-1']);
    await dismiss(dir, 'helper-1', 1700);
    assert.deepEqual(rows({ ...stopped, updated: 1600 }), [], 'dismissed again');
    assert.deepEqual(rows({ ...stopped, updated: 1800 }), ['helper-1'], 'moved since, without being seen running');

    // a row with an MR is keyed by its URL, which is refused above; an agent id dismissed earlier doesn't hide its later MR row
    await dismiss(dir, 'helper-1', 9999);
    assert.deepEqual(rows({ ...stopped, prs: [mr(5)] }, [{ url: mr(5), at: 1 }]), [mr(5)]);

    writeFileSync(join(dir, 'dismissed.json'), '[["helper-1", 99');
    loadDismissed(dir);
    assert.deepEqual(rows(stopped), ['helper-1'], 'nothing kept from a broken file');
    for (let n = 0; n < 501; n++) {
        await dismiss(dir, `h${n}`, n);
    }
    const saved = JSON.parse(readFileSync(join(dir, 'dismissed.json'), 'utf8'));
    assert.deepEqual([saved.length, saved[0], saved.at(-1)], [500, ['h1', 1], ['h500', 500]], 'the oldest goes first');
    loadDismissed(join(dir, 'none'));
    console.log('ok dismissed rows');
}
