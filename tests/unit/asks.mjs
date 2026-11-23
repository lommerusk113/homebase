import assert from 'node:assert/strict';
import { chatItems, pendingQuestion, quickReplies, pendingAsk, askList, optionLabels, namedChoices, waitingOn, waitingAsk } from '../../server.mjs';
import { tu, say } from './helpers.mjs';

const YN = ['Yes', 'No'], YBN = ['Yes', 'Do both', 'No'];
assert.deepEqual(quickReplies('Want me to commit?', 'Fixed it.'), YN);
assert.deepEqual(quickReplies(null, 'Fixed the parser.\n\nShall I push it?'), YN);
assert.deepEqual(quickReplies('Fixed.', 'Done.\n\nWant me to **also** update the docs?'), YN);
assert.deepEqual(quickReplies('**Fix the parser or the renderer?**', 'Two causes.'), YBN);
assert.deepEqual(quickReplies(null, 'Two ways.\n\nShould I go with A, or B?'), YBN);
assert.deepEqual(quickReplies('Commit it or not?', ''), YN);
assert.deepEqual(quickReplies('Fixed the crash.', 'Why did it fail? A stale cache.\n\nCleared it.'), []); // rhetorical, mid-body
assert.deepEqual(quickReplies(null, 'He asked "should we ship?"'), []); // quoted
assert.deepEqual(quickReplies(null, 'Done.\n\n> Can we skip this?'), []);
assert.deepEqual(quickReplies(null, '```\nwhat?\n```'), []);
assert.deepEqual(quickReplies(null, 'Open points:\n- Rename it?\n- Drop the flag?'), []); // several questions
assert.deepEqual(quickReplies(null, ''), []);
assert.deepEqual(chatItems([say('Done.\n\nShip it?')]).at(-1).replies, YN);
assert.equal(chatItems([say('Ship it?'), { type: 'user', message: { content: 'yes' } }])[0].replies, undefined);
const you = (text, at) => ({ type: 'user', message: { content: text }, timestamp: at });
const tagged = chatItems([say('Fix A or B?'), you('Do both', 't1')]); // chip answer
assert.deepEqual(tagged.map(i => [i.role, i.answer, i.replies]), [['assistant', { text: 'Do both', at: 't1' }, undefined]]);
assert.deepEqual(chatItems([say('Ship it?'), you('yes')]).map(i => [i.role, i.answer?.text]), [['assistant', 'yes']]); // typed
assert.deepEqual(chatItems([say('Ship it?'), you('Go ahead!')])[0].answer.text, 'Go ahead!');
assert.deepEqual(chatItems([say('Ship it?'), you('yes, but also do X')]).map(i => [i.role, i.answer]), [['assistant', undefined], ['user', undefined]]);
assert.deepEqual(chatItems([say('Done.'), you('yes')]).map(i => i.role), ['assistant', 'user']); // not after a question
assert.deepEqual(chatItems([you('yes')]).map(i => i.role), ['user']);
// an answer to an older question: Claude said more after asking, so "yes" is a bubble
assert.deepEqual(chatItems([say('Ship it?'), tu('Bash'), say('Also cleaned up.'), you('yes')]).map(i => [i.role, i.answer]),
    [['assistant', undefined], ['tools', undefined], ['assistant', undefined], ['user', undefined]]);
assert.deepEqual(chatItems([say('Ship it?'), you('yes'), you('no')]).map(i => i.role), ['assistant', 'user']); // one answer per question
assert.deepEqual(chatItems([say('Ship it?'), { type: 'queue-operation', operation: 'enqueue', content: 'Yes', timestamp: 't2' }])[0].answer, { text: 'Yes', at: 't2', queued: true });
// chips stay on an older unanswered question after Claude says more
const sayAt = (text, at) => ({ type: 'assistant', timestamp: at, message: { content: [{ type: 'text', text }] } });
const noTools = e => chatItems(e).filter(i => i.role !== 'tools');
assert.deepEqual(chatItems([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2')]).map(i => i.replies), [YN, undefined, []]);
// its chip answer carries the question's timestamp: paired to that question and stripped
const earlier = '\n\n(Answering your earlier question from t1: "Ship it?")';
const paired = noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2'), you('Yes' + earlier, 't3')]);
assert.deepEqual(paired.map(i => [i.role, i.answer, i.needsYou, i.replies]), [['assistant', { text: 'Yes', at: 't3' }, false, undefined], ['assistant', undefined, false, []]]);
const two = noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Done.\n\nTLDR: Merge it?', 't2'), you('No' + earlier, 't3')]);
assert.deepEqual(two.map(i => [i.answer?.text, i.replies]), [['No', undefined], [undefined, YN]]); // the right question
// a plain later message still clears the older question
assert.deepEqual(noTools([sayAt('Done.\n\nTLDR: Ship it?', 't1'), tu('Bash'), sayAt('Also cleaned up.', 't2'), you('ok whatever, later', 't3')]).map(i => [i.role, i.needsYou, i.replies]), [['assistant', false, undefined], ['assistant', false, undefined], ['user', undefined, undefined]]);
const ask2 = tu('AskUserQuestion', { id: 'q2', input: { questions: [{ question: 'Which DB?', options: [{ label: 'Postgres', description: 'x' }, { label: 'SQLite' }] }] } });
assert.deepEqual(pendingAsk([ask2]), [{ question: 'Which DB?', options: ['Postgres', 'SQLite'], descriptions: ['x', ''] }]);
assert.equal(pendingAsk([ask2, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] } }]), null);
assert.equal(pendingQuestion([tu('AskUserQuestion', { id: 'q3', input: {} })]), 'Claude asked a question.');
// an AskUserQuestion answered in the card answers the message that asked: no needs-you and no stale chips afterwards
const askedDb = [sayAt('**▸ DB · needs you**\n\nTLDR: Which DB?', 't1'), ask2];
const answeredDb = { type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'q2' }] }, toolUseResult: { answers: { 'Which DB?': 'Postgres' } } };
assert.deepEqual(noTools([...askedDb, answeredDb]).map(i => [i.answer, i.needsYou, i.replies]), [[{ text: 'Postgres', at: 't2' }, false, undefined]]);
assert.deepEqual(noTools([...askedDb, { ...answeredDb, toolUseResult: 'Error', message: { content: [{ ...answeredDb.message.content[0], is_error: true }] } }])[0].answer.text, 'No answer');
assert.equal(noTools([...askedDb])[0].needsYou, true);
console.log('ok ask answers');
assert.equal(askList('Two ways.\n\nWhich one?\n\n1. **A** fast\n   but risky\n2. **B** safe\n\nI pick A.'), 'Which one?\n\n1. **A** fast\n   but risky\n2. **B** safe');
assert.equal(askList('Pick one?\n- A\n\n- B'), 'Pick one?\n- A\n\n- B');
assert.equal(askList('Pick:\n- A\n\n- B'), null); // not asked: a list, not a choice
assert.equal(askList('**Option A**: x\n**Option B**: y'), '**Option A**: x\n**Option B**: y');
assert.equal(askList('No list here. Ship it?'), null);
assert.equal(askList('Long intro.\nOptions:\nprose after'), null);
const opts = chatItems([say('**▸ DB · needs you**\n\nChanged things.\n\nWhich DB?\n- Postgres\n- SQLite\n\n**TLDR:** pick one, **Postgres** recommended')]).at(-1);
assert.equal(opts.options, 'Which DB?\n- Postgres\n- SQLite');
assert.equal(chatItems([say('Did:\n- a\n- b\n\nTLDR: done')]).at(-1).options, undefined); // not a question
assert.deepEqual(optionLabels('Which?\n\n1. **Postgres** (Recommended) — fast\n   more detail\n2. **SQLite**: simple'), ['Postgres (Recommended)', 'SQLite']);
assert.deepEqual(optionLabels('- Keep it — less work\n- Drop it: cleaner\n  - a sub-point'), ['Keep it', 'Drop it']);
assert.deepEqual(optionLabels('**Option A**: x\n**Option B**: y'), ['Option A', 'Option B']);
{ // the closing In flight list never becomes the chips; an explicit **Options** list does
    const [r] = chatItems([say('**▸ Cache layer**\n\nTwo things block the cache.\n\n**Options**\n1. **Redis** — shared, needs a server\n2. **In-memory** — simplest\n3. **Skip it** — revisit later\n\nI lean Redis.\n\n**In flight**\n- Nothing running\n- Waiting on you: which cache\n\n**TLDR:** Which cache should I build? **Redis** is my pick.')]);
    assert.equal(r.needsYou, true, 'a TLDR with a question mid-line needs you');
    assert.deepEqual(r.replies, ['Redis', 'In-memory', 'Skip it']);
    assert.ok(r.options.startsWith('**Options**') && r.text.includes(r.options) && !r.options.includes('In flight'));
}
assert.deepEqual(namedChoices('**Rebased onto main.** Merge it now? Yes or later.'), ['Yes', 'Later']);
assert.deepEqual(namedChoices('Ready to deploy; say **go**'), ['Go']);
assert.deepEqual(namedChoices('Shipped the fix. Nothing else to do.'), []);
{ // a needs-you reply with no ?-options gets chips for the choices its TLDR or Waiting on you names
    const [a] = chatItems([say('Rebased.\n\n**TLDR:** Rebased **!12** onto main. Merge now? Yes or later.')]);
    assert.deepEqual(a.replies, ['Yes', 'Later']);
    const [b] = chatItems([say('Built it.\n\n**In flight**\n- Waiting on you: say go to deploy\n\n**TLDR:** Build is green.')]);
    assert.deepEqual(b.replies, ['Go']);
    assert.deepEqual(chatItems([say('Built it.\n\n**TLDR:** Build is green, say go to deploy when you like')])[0].replies, [], 'not a needs-you reply');
}
{ // a Heads-up line leaves the body for its own field, shown next to the TLDR
    const [h] = chatItems([say('Done.\n\n**Heads-up:** the migration locks the table for a minute.\n\n**TLDR:** Migration is ready.')]);
    assert.equal(h.headsUp, 'the migration locks the table for a minute.');
    assert.equal(h.text, 'Done.');
}
assert.equal(waitingOn('**In flight**\n- Nothing running\n- Waiting on you: which cache'), 'which cache');
assert.equal(waitingOn('**Waiting on you:** merge **!12**'), 'merge **!12**');
assert.equal(waitingOn('**Waiting on you: pick a port**'), 'pick a port');
assert.equal(waitingOn('- Waiting on you — nothing'), null);
assert.equal(waitingOn('- Waiting on you: none, all done'), null);
assert.equal(waitingOn('Waiting on your review is not a line'), null);
{ // an open decision outlives a later message: the newest reply's Waiting on you, with the chips of its list
    const ask = '**▸ Cache layer**\n\n**Options**\n1. **Redis** — shared\n2. **In-memory** — simplest\n\n**In flight**\n- Waiting on you: which cache\n\n**TLDR:** Which cache?';
    const items = chatItems([say(ask), { type: 'user', message: { content: 'also fix the typo in the README' } }, say('Fixed the typo.\n\n**In flight**\n- Nothing running\n- Waiting on you: which cache (Redis or in-memory)\n\n**TLDR:** Typo fixed.')]);
    assert.equal(items.at(-1).waiting, 'which cache (Redis or in-memory)');
    assert.equal(items.at(-1).needsYou, true);
    assert.equal(items[0].needsYou, false, 'the older question itself is replied to');
    const done = chatItems([say(ask), say('Built Redis.\n\n**In flight**\n- Waiting on you: nothing\n\n**TLDR:** Redis cache is in.')]).at(-1);
    assert.equal(done.waiting, undefined);
}
assert.deepEqual(optionLabels('- only one'), []);
assert.deepEqual(optionLabels(Array.from({ length: 7 }, (_, n) => `- item ${n}`).join('\n')), []); // too many to be choices
assert.equal(optionLabels(`- ${'x'.repeat(80)}\n- y`)[0].length, 60);
// a listed choice: one chip per option instead of Yes / No, and clicking one pairs as the answer
const pick = '**▸ DB · needs you**\n\nWhich DB?\n- **Postgres** (Recommended)\n- **SQLite**\n\n**TLDR:** pick one?';
assert.deepEqual(chatItems([say(pick)]).at(-1).replies, ['Postgres (Recommended)', 'SQLite']);
assert.deepEqual(chatItems([say(pick), you('SQLite', 't1')]).map(i => [i.role, i.answer?.text, i.replies]), [['assistant', 'SQLite', undefined]]);
// needs you without a TLDR: the closing ask is what shows folded, not the opening sentence
const noTldr = chatItems([say('**▸ Deploy · needs you**\n\nBuilt it.\n\nThe tests pass.\n\nDeploy to prod now?')]).at(-1);
assert.deepEqual([noTldr.tldr, noTldr.text], ['Deploy to prod now?', 'Built it.\n\nThe tests pass.']);
// no needs-you marker but a closing question with chips: the same, so the question shows next to them
const plainAsk = chatItems([say('Built it.\n\nThe tests pass.\n\nDeploy to prod now?')]).at(-1);
assert.deepEqual([plainAsk.needsYou, plainAsk.tldr, plainAsk.text, plainAsk.replies], [false, 'Deploy to prod now?', 'Built it.\n\nThe tests pass.', ['Yes', 'No']]);
{ // a "what changed" list in a needs-you reply is not a set of choices: no options, no chips from it
    const body = "**▸ !1850 polish done · needs you**\n\nThe polish pass on !1850 (asking before booking items that supplier automation stopped) added tests for three things:\n\n- the duplicate dialog comes first\n- cancelling the dialog skips payment\n- a double click doesn't open a second dialog\n\n**TLDR:** !1850 (confirm stopped items) is polished locally. Tell me what to clarify about #2281 (rule supplier naming) before it's pushed.";
    const [r] = chatItems([say(body)]);
    assert.equal(r.needsYou, true);
    assert.equal(r.options, undefined);
    assert.ok(!r.replies.includes('the duplicate dialog comes first'), `got ${r.replies}`);
}
{ // the Waiting on you line as the rules write it: question, context and one chip per numbered option
    const w = "#2281, naming the rule's supplier in Aktivitetslogg, on «Forhåndsutfylt av regel» and in the voucher timeline — it's implemented and all its tests pass, and you stopped my push question because you wanted to clarify something — what do you want to clarify? — (1) how the supplier name is read: a read-only database lookup when the rule is loaded, so no new column and never out of date (recommended, already built); (2) the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»; (3) something else.";
    assert.deepEqual(waitingAsk(w), {
        question: 'what do you want to clarify?',
        context: "#2281, naming the rule's supplier in Aktivitetslogg, on «Forhåndsutfylt av regel» and in the voucher timeline — it's implemented and all its tests pass, and you stopped my push question because you wanted to clarify something",
        options: [
            { label: 'how the supplier name is read (recommended)', desc: 'a read-only database lookup when the rule is loaded, so no new column and never out of date (recommended, already built)' },
            { label: 'the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»', desc: '' },
            { label: 'something else', desc: '' }
        ]
    });
    assert.deepEqual(waitingAsk('Merge !12? 1. **Yes** — now 2. Later').options.map(o => o.label), ['Yes', 'Later']);
    assert.deepEqual(waitingAsk('which cache — A) Redis — shared, B) in-memory').options.map(o => o.label), ['Redis', 'in-memory']);
    assert.equal(waitingAsk('which cache, Redis or in-memory'), null);
    {
        const lbl = x => waitingAsk(x).options.map(o => o.label);
        assert.deepEqual(lbl('Q? — (1) a; (2) b'), ['a', 'b']);
        assert.deepEqual(lbl('Q? — (1) a (2) b'), ['a', 'b']);
        assert.deepEqual(lbl('Q? — 1) a 2) b'), ['a', 'b']);
        assert.deepEqual(lbl('Q? — (1, recommended) wait for PetterGT; (2) keep 2400 and reply so; (3) build an account choice for the accountant.'),
            ['wait for PetterGT (recommended)', 'keep 2400 and reply so', 'build an account choice for the accountant']);
    }
    assert.equal(waitingAsk('merge !1850 (1) only'), null);
    const [r] = chatItems([say(`Built it.\n\n**Waiting on you:** ${w}\n\n**TLDR:** Tell me what to clarify.`)]);
    assert.deepEqual(r.replies, ['how the supplier name is read (recommended)', 'the tooltip text «Forhåndsutfylt av leverandørautomatisering, regel for {leverandør}»', 'something else']);
    assert.equal(r.ask.question, 'what do you want to clarify?');
    const [a, b] = chatItems([say(`Built it.\n\n**Waiting on you:** ${w}`), { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }, say(`Still waiting.\n\n**Waiting on you:** ${w}`)]);
    assert.deepEqual([a.replies, b.replies.length], [undefined, 3], 'a later Waiting on you takes the older one\'s chips');
}
console.log('ok ask list');
console.log('ok quick replies');
