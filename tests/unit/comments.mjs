import assert from 'node:assert/strict';
import { isBot, humanComments, withThreads } from '../../server.mjs';
import { attentionEvents, askingEvents } from '../../web/src/lib/board.ts';
import { freshComments, authorSummary } from '../../web/src/lib/comments.ts';
import { projectCounts } from '../../web/src/lib/waiting.ts';
import { open, mr, nextOf, colOf, actOf } from './helpers.mjs';

const it = (key, column, ci) => ({ key, column, prState: ci ? { ci } : null });
const ev = (prev, next) => attentionEvents(prev, next).map(e => [e.kind, e.item.key]);
assert.deepEqual(ev(null, [it('a', 'needs-you')]), []); // first load
assert.deepEqual(ev([it('a', 'review')], [it('a', 'needs-you')]), [['needs-you', 'a']]);
assert.deepEqual(ev([it('a', 'needs-you')], [it('a', 'needs-you')]), []);
assert.deepEqual(ev([it('a', 'review')], [it('a', 'ready')]), [['ready', 'a']]);
assert.deepEqual(ev([it('a', 'doing')], [it('a', 'ready')]), [['ready', 'a']]); // one event per item
assert.deepEqual(ev([it('a', 'doing'), it('b', 'doing')], [it('a', 'review'), it('b', 'done')]), [['finished', 'a'], ['finished', 'b']]);
assert.deepEqual(ev([it('a', 'doing')], []), [['finished', 'a']]); // agent without an MR drops off
assert.deepEqual(ev([it('a', 'doing')], [it('a', 'finished')]), [['finished', 'a']]);
assert.deepEqual(ev([it('a', 'review')], []), []);
assert.deepEqual(ev([it('a', 'review')], [it('a', 'review', 'failing')]), [['failing', 'a']]);
assert.deepEqual(ev([it('a', 'review', 'failing')], [it('a', 'review', 'failing')]), []);
assert.deepEqual(ev([], [it('n', 'needs-you'), it('m', 'review')]), [['needs-you', 'n']]);
// sessions that start waiting on the user: asking, or idle with a needs-you reply; working or a sidechain doesn't count
const ss = (id, o = {}) => ({ id, status: 'idle', asking: false, needsYou: false, sidechain: false, ...o });
const aev = (prev, next) => askingEvents(prev, next).map(e => [e.kind, e.session.id]);
assert.deepEqual(aev(undefined, [ss('a', { asking: true })]), []); // first load
assert.deepEqual(aev([ss('a'), ss('b')], [ss('a', { asking: true }), ss('b', { needsYou: true })]), [['asking', 'a'], ['asking', 'b']]);
assert.deepEqual(aev([ss('a', { asking: true })], [ss('a', { asking: true })]), []);
assert.deepEqual(aev([ss('a')], [ss('a', { needsYou: true, status: 'working' }), ss('c', { asking: true, sidechain: true })]), []);
assert.deepEqual(aev([], [ss('n', { needsYou: true })]), [['asking', 'n']]);
// comment events: newer than seen and than the previous poll's newest; none before comments were loaded
const cm = (key, ...ats) => ({ key, pr: `u/${key}`, column: 'review', comments: { latestAt: ats[0] ?? null, count: ats.length, items: ats.map((at, i) => ({ id: i, author: 'Børre Stellander', at })) } });
const CT = t => `2026-11-13T10:0${t}:00Z`, S = t => Date.parse(CT(t));
const cev = (prev, next, seen) => attentionEvents(prev, next, () => seen).map(e => [e.kind, e.item.key, e.comments?.length]);
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(2), CT(1))], S(0)), [['comment', 'a', 1]]);
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(1))], S(0)), []); // nothing newer than last poll
assert.deepEqual(cev([cm('a', CT(1))], [cm('a', CT(2), CT(1))], S(3)), []); // already seen
assert.deepEqual(cev([{ key: 'a', pr: 'u/a', column: 'review' }], [cm('a', CT(2))], S(0)), []); // comments just loaded
assert.deepEqual(cev([cm('a')], [cm('a', CT(2))], S(0)), [['comment', 'a', 1]]); // first comment on the MR
assert.deepEqual(ev([it('a', 'review')], [it('a', 'needs-you')]), [['needs-you', 'a']]); // default seen keeps old calls working
console.log('ok attention');
{
    const items = cols => cols.map((column, i) => ({ key: `${column}${i}`, column }));
    const sessions = [
        { id: 'a', project: 'alpha', status: 'idle', needsYou: true, asking: false, items: items(['doing', 'review', 'needs-you', 'done', 'finished']) },
        { id: 'b', project: 'beta', status: 'working', needsYou: true, asking: false, items: items(['ready']) },
        { id: 'c', project: 'beta', status: 'idle', asking: true, sidechain: true },
        { id: 'd', project: 'other', status: 'idle', asking: true }
    ];
    assert.deepEqual(projectCounts(sessions, ['beta', 'alpha', 'gamma']), [
        { project: 'alpha', waiting: 2 } // beta is working and its sidechain's question isn't the user's; gamma has nothing: both left out
    ]);
    assert.deepEqual(projectCounts([], ['alpha']), []);
    // a chat asking about an MR whose row is in Needs you counts once (its row stands for it)
    assert.deepEqual(projectCounts([{ id: 'e', project: 'p', status: 'waiting', asking: true, items: [{ key: 'k', column: 'needs-you', askedBy: 'e' }] }], ['p']), [{ project: 'p', waiting: 1 }]);
    console.log('ok project counts');
}
const c3 = { items: [{ at: CT(3), author: 'Børre Stellander' }, { at: CT(2), author: 'Ann Lee' }, { at: CT(1), author: 'Børre Stellander' }] };
assert.deepEqual(freshComments(c3, S(1)).map(c => c.at), [CT(3), CT(2)]);
assert.deepEqual(freshComments(null, 0), []);
assert.equal(authorSummary(c3.items), 'Børre, Ann');
assert.equal(authorSummary([...c3.items, { author: 'Kim X' }]), 'Børre, Ann +1');
assert.equal(isBot({ username: 'dependabot[bot]' }), true);
assert.equal(isBot({ username: 'project_123_bot_ab12' }), true);
assert.equal(isBot({ username: 'renovate-bot' }), true);
assert.equal(isBot({ username: 'x', type: 'Bot' }), true);
assert.equal(isBot({ username: 'borre.stellander' }), false);
assert.equal(isBot({ username: 'abbott' }), false);
const raw = [
    { id: 1, author: { name: 'Joakim', username: 'me' }, at: CT(5), body: 'mine', url: 'u#1' },
    { id: 2, author: { name: 'Bot', username: 'gitlab-bot' }, at: CT(4), body: 'beep', url: 'u#2' },
    { id: 3, author: { name: 'Børre Stellander', username: 'borre' }, at: CT(1), body: '**Old** note', url: 'u#3', resolved: false },
    { id: 4, author: { name: 'Børre Stellander', username: 'borre' }, at: CT(3), body: 'x'.repeat(200), url: 'u#4', resolved: null },
    { id: 5, author: { name: 'Ann', username: 'ann' }, at: CT(2), body: '  ', url: 'u#5' }
];
const hc = humanComments(raw, 'me');
assert.deepEqual(hc.items.map(c => c.id), [4, 3]); // self, bot and empty dropped; newest first
assert.equal(hc.latestAt, CT(3));
assert.equal(hc.count, 2);
assert.equal(hc.items[1].excerpt, 'Old note');
assert.equal(hc.items[1].resolved, false);
assert.equal('resolved' in hc.items[0], false);
assert.equal(hc.unresolved, 1);
assert.deepEqual(hc.unresolvedBy, ['Børre Stellander']);
// unresolved human threads on an open MR: needs-you, it's on me, ahead of CI like requested changes
const waiting = open({ reviewers: ['Børre Stellander'] });
const thr = (n, by = ['Børre Stellander']) => ({ count: n + 1, items: [], unresolved: n, unresolvedBy: n ? by : [] });
const t2 = withThreads({ ...waiting, ci: 'failing' }, thr(2));
assert.equal(colOf(t2, null, true), 'needs-you');
assert.equal(nextOf(t2, null), 'Address 2 unresolved comments from Børre Stellander · Pipeline failing');
assert.equal(nextOf(withThreads(waiting, thr(1, ['A', 'B'])), null), 'Address 1 unresolved comment from A, B');
assert.equal(actOf(mr(4), t2, null, 'T').label, 'Fix & reply');
assert.equal(colOf(withThreads(waiting, thr(0)), null, true), 'review'); // all resolved, no approval yet
assert.equal(nextOf(withThreads(waiting, thr(0)), null), 'Waiting for review by Børre Stellander');
assert.equal(withThreads(waiting, null), waiting); // no comments data yet
// a stopped agent needs you even when its MR is ready; a finished one without an MR is "finished"
assert.equal(colOf(open({ ready: true }), { status: 'stopped' }, true), 'needs-you');
assert.equal(colOf(null, { status: 'stopped' }, false), 'needs-you');
assert.equal(colOf(null, { status: 'done' }, false), 'finished');
assert.equal(colOf(open({ draft: true }), null, true), 'needs-you'); // a draft can't be reviewed: marking it ready is on you
assert.equal(colOf(open({ draft: true, ci: 'running' }), null, true), 'review', 'not while its pipeline runs: nothing to do yet');
assert.equal(withThreads({ state: 'merged' }, thr(2)).changes, undefined);
// the comment that moves an item into needs-you notifies once
const nc = { ...cm('a', CT(2)), column: 'needs-you' };
assert.deepEqual(cev([cm('a', CT(1))], [nc], S(0)), [['comment', 'a', 1]]);
assert.ok(hc.items[0].excerpt.length <= 141);
assert.equal(humanComments(raw, 'me', 1).items.length, 1);
assert.deepEqual(humanComments([], 'me'), { latestAt: null, count: 0, items: [], unanswered: 0, unansweredBy: [], unresolved: 0, unresolvedBy: [], replied: 0, repliedTo: [] });
// whose turn per GitLab thread: the last human note decides; replied threads wait on the reviewer
const B = { name: 'Børre', username: 'borre' }, ME = { name: 'Joakim', username: 'me' }, BOT = { name: 'Bot', username: 'gitlab-bot' };
const th = (...authors) => ({ resolved: false, notes: authors.map(author => ({ author })) });
const turn = (...threads) => humanComments([], 'me', 10, threads);
const mine = turn(th(B, ME), th(B, ME, BOT)); // last note by me (my Claude posts as me), a bot after me doesn't count
assert.deepEqual([mine.unresolved, mine.replied, mine.repliedTo], [0, 2, ['Børre']]);
const wr = withThreads({ ...waiting, changes: true }, mine); // GitLab's discussions_not_resolved set changes
assert.equal(colOf(wr, null, true), 'review');
assert.equal(nextOf(wr, null), 'Replied to 2 threads — waiting for Børre to resolve');
assert.equal(actOf(mr(4), wr, null, 'T'), null);
assert.equal(actOf(mr(4), { ...wr, reviewers: [] }, null, 'T'), null); // no Request review either
assert.equal(actOf(mr(4), { ...wr, ci: 'failing' }, null, 'T').label, 'Fix pipeline'); // only a failing pipeline beats it
assert.equal(nextOf({ ...wr, ci: 'running' }, null), 'Replied to 2 threads — waiting for Børre to resolve');
// mergeable wins over replied threads; unanswered comments and a failing pipeline still win over mergeable
const wrReady = { ...wr, ready: true };
assert.equal(colOf(wrReady, null, true), 'ready');
assert.equal(nextOf(wrReady, null), 'Approved — merge it · 2 replied threads still open');
assert.equal(actOf(mr(4), wrReady, null, 'T').label, 'Merge + close issue');
assert.equal(nextOf({ ...wrReady, replied: 1 }, null), 'Approved — merge it · 1 replied thread still open');
assert.equal(actOf(mr(4), { ...wrReady, ci: 'failing' }, null, 'T').label, 'Fix pipeline');
const theirsReady = withThreads({ ...waiting, ready: true }, turn(th(B), th(ME, B)));
assert.equal(nextOf(theirsReady, null), 'Approved — 2 unanswered comments from Børre');
assert.equal(actOf(mr(4), theirsReady, null, 'T').label, 'Fix & reply');
const theirs = turn(th(B), th(ME, B));
assert.deepEqual([theirs.unresolved, theirs.unresolvedBy, theirs.replied], [2, ['Børre'], 0]);
assert.equal(colOf(withThreads(waiting, theirs), null, true), 'needs-you');
const mix = withThreads(waiting, turn(th(B), th(B, ME)));
assert.equal(colOf(mix, null, true), 'needs-you');
assert.equal(nextOf(mix, null), 'Address 1 unresolved comment from Børre');
assert.equal(actOf(mr(4), mix, null, 'T').label, 'Fix & reply');
// a thread whose last note, by the reviewer, hands it to someone else with an @mention waits on that person
const hand = (author, body) => ({ author, body });
const handed = turn({ resolved: false, notes: [hand(B, 'is 2400 right?'), hand(ME, 'No code change'), hand(B, '@PetterGT should take a look')] });
assert.deepEqual([handed.unresolved, handed.replied, handed.repliedTo], [0, 1, ['PetterGT']]);
assert.equal(nextOf(withThreads({ ...waiting, changes: true }, handed), null), 'Replied to 1 thread — waiting for PetterGT to resolve');
assert.equal(turn({ resolved: false, notes: [hand(B, '@me what about this'), ] }).unresolved, 1); // mentioning me is still on me
assert.equal(turn({ resolved: false, notes: [hand(B, 'ping @borre')] }).unresolved, 1); // own name is no hand-off
const done = turn({ ...th(B), resolved: true }, th(ME), th(BOT)); // resolved, my own, bot-only threads don't count
assert.deepEqual([done.unresolved, done.replied], [0, 0]);
assert.equal(withThreads(waiting, done), waiting);
// a non-resolvable general comment is a new comment, not a thread
const gen = humanComments([{ id: 9, author: B, at: CT(1), body: 'LGTM', url: 'u#9', resolved: null }], 'me', 10, []);
assert.deepEqual([gen.count, gen.unresolved, gen.replied, gen.unanswered], [1, 0, 0, 0]);
// general comments by others after my newest note (thread or general) are on me
const note = (author, s, general = true) => ({ id: s, author, at: CT(s), body: 'x', url: `u#${s}`, resolved: general ? null : false, general });
const ANN = { name: 'Ann', username: 'ann' };
const asked = humanComments([note(ME, 1), note(B, 2)], 'me', 10, []);
assert.deepEqual([asked.unanswered, asked.unansweredBy], [1, ['Børre']]);
const askedPr = withThreads(waiting, asked);
assert.equal(colOf(askedPr, null, true), 'needs-you');
assert.equal(nextOf(askedPr, null), "Reply to Børre's comment");
assert.deepEqual(actOf(mr(4), askedPr, null, 'T'), { label: 'Fix & reply', message: `Address the review comments on !4 (${mr(4)}), push, and reply in each thread.` });
assert.equal(withThreads(waiting, humanComments([note(B, 2), note(ME, 3, false)], 'me', 10, [])), waiting); // my later thread note answers it
assert.equal(withThreads(waiting, humanComments([note(ME, 1), note(BOT, 2)], 'me', 10, [])), waiting); // bots don't count
assert.equal(nextOf(withThreads(waiting, humanComments([note(ME, 1), note(B, 2), note(ANN, 3)], 'me')), null), 'Answer 2 comments from Ann, Børre');
const both = withThreads(waiting, humanComments([note(B, 2)], 'me', 10, [th(B), th(ANN)]));
assert.deepEqual([both.unresolved, both.unanswered], [2, 1]);
assert.equal(nextOf(both, null), 'Address 2 unresolved threads and answer 1 comment from Børre, Ann');
const askedReady = withThreads({ ...waiting, ready: true }, asked);
assert.equal(nextOf(askedReady, null), 'Approved — 1 unanswered comment from Børre');
assert.equal(actOf(mr(4), askedReady, null, 'T').label, 'Fix & reply');
assert.equal(withThreads(waiting, humanComments([], 'me', 10, [])), waiting); // no comments
console.log('ok comments');
