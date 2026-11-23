import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseQuestion, answerQuestion, saveUpload, readUpload, UPLOAD_MAX, UPLOAD_NAME, cancelQuestion, questionOpen } from '../../server.mjs';
import { seenHash } from '../../public/core.js';
import { pasteLabel, isLongPaste, expandPastes } from '../../web/src/lib/draft.ts';
import { claudeLine, rulesFile, loginShell } from '../../server/tmux.mjs';
import { saverOn, saveSaver, saverRules, syncSaver, SAVER_RULE } from '../../server/saver.mjs';
import { projectOf } from '../../server/sessions.mjs';

{
    const ask = sel => `❯ Ask me which color
────────────────
 ☐ Color

Which color
do you want?

${sel === 0 ? '❯' : ' '} 1. Green (Recommended)
     calm and
     quiet
${sel === 1 ? '❯' : ' '} 2. Red
     warm
${sel === 2 ? '❯' : ' '} 3. Blue
  4. Type something.
────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    assert.deepEqual(parseQuestion(ask(0)), {
        question: 'Which color do you want?',
        options: ['Green (Recommended)', 'Red', 'Blue', 'Type something.', 'Chat about this'],
        descriptions: ['calm and quiet', 'warm', '', '', ''],
        selected: 0
    });
    assert.equal(parseQuestion(ask(2)).selected, 2);
    assert.equal(parseQuestion(ask(0).replace('Enter to select', '')), null, 'needs the hint');
    assert.equal(parseQuestion(ask(0).replace('1. Green', '1. [ ] Green')), null, 'multi-select is left to the terminal');
    const submit = '←  ☒ Size  ☒ Shape  ✔ Submit  →\n\nReview your answers\n\n ● Which size?\n   → Large\n ● Which shape?\n   → Square\n\n❯ 1. Submit answers\n  2. Cancel\n\n';
    assert.deepEqual(parseQuestion(submit), { question: 'Review your answers · Which size? → Large · Which shape? → Square', options: ['Submit answers', 'Cancel'], descriptions: ['', ''], selected: 0 }, 'the submit step has no hint');
    assert.equal(parseQuestion('❯ 1. my typed list\n'), null, 'no hint, no review: not a question');
    assert.equal(parseQuestion(' Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm'), null, 'not a question');

    // Claude Code's "Switch model?" confirmation (a real pane, after a /model pick): numbered options and no footer at all
    const bare = readFileSync(new URL('../fixtures/dialog-switch-model.txt', import.meta.url), 'utf8');
    assert.deepEqual(parseQuestion(bare), {
        question: 'This conversation is cached for the current model. Switching to Fable 5.2 means the full history gets re-read.',
        options: ['Yes, switch to Fable 5.2', 'No, go back'], descriptions: ['', ''], selected: 0
    }, 'a dialog without a footer, its options at the bottom of the pane');
    assert.equal(parseQuestion('reply\n────\n❯ 1. my typed list\n  2. second\n────\n  ⏵⏵ auto mode\n'), null, 'a list typed in the input box is not a dialog');
    assert.equal(parseQuestion('reply\n\n❯ 1. my typed list\n'), null, 'one option is not a dialog');

    const run = async (panes, index, label, name = 'cc-new-probe') => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void sent.push(a));
        const seen = seenHash(parseQuestion(panes[0]) ?? { question: '' });
        const err = await answerQuestion(name, index, label, { tm, nap: async () => {}, seen }).then(() => null, e => e);

        return { sent, err };
    };
    assert.equal((await answerQuestion('cc-new-probe', 0, 'Red', { tm: async () => ({ stdout: '' }) }).catch(e => e)).status, 400, 'no seen: refused');
    const moved = bare.replace('❯ 1.', '  1.').replace('  2. No', '❯ 2. No');
    assert.deepEqual((await run([bare, moved, 'switched back'], 1, 'No, go back')).sent, [['send-keys', '-t', '=cc-new-probe:', 'Down'], ['send-keys', '-t', '=cc-new-probe:', 'Enter']], 'its options answer by click');
    let r = await run([ask(0), ask(1), 'Red'], 1, 'Red');
    assert.equal(r.err, null);
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down'], ['Enter']]);
    r = await run([ask(0), ask(0), ask(0), ask(2), 'Blue'], 2, 'Blue');
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down'], ['Down', 'Down'], ['Down', 'Down'], ['Enter']], 'dropped arrows are resent');
    r = await run([ask(0)], 1, 'Red');
    assert.equal(r.err.status, 502, 'arrows never land');
    assert.ok(!r.sent.some(a => a.includes('Enter')), 'never confirms another option');
    r = await run([ask(0), ask(1).replace('Which color', 'Which shade')], 1, 'Red');
    assert.equal(r.err.status, 409, 'the question changed under the arrows');
    assert.ok(!r.sent.some(a => a.includes('Enter')));
    r = await run([ask(0)], 1, 'Blue');
    assert.equal(r.err.status, 409, 'label mismatch');
    assert.deepEqual(r.sent, []);
    assert.equal((await run([ask(0)], 3, 'Type something.')).err.status, 400, 'the text box entry is not answered');
    r = await run([ask(0), ask(0).replace('❯ 1.', '  1.').replace('  5. Chat', '❯ 5. Chat'), 'declined'], 4, 'Chat about this');
    assert.equal(r.err, null, 'Chat about this is selected like an option');
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down', 'Down', 'Down'], ['Enter']]);
    assert.equal((await run([ask(0)], 1, 'Red', 'zsh')).err.status, 400, 'not a cc-* session');
    r = await run([ask(0), ask(1), ask(1).replace('Which color\ndo you want?', 'Which size?')], 1, 'Red');
    assert.equal(r.err, null, 'the next question of a multi-question dialog counts as answered');

    // A question taller than the 80x24 pane (captured from a real Claude Code, text replaced): its top is clipped and a
    // "↑ 5 more lines" scroll marker sits under the options. The marker is no option's description; typing still cancels it.
    const clipped = readFileSync(new URL('../fixtures/question-clipped.txt', import.meta.url), 'utf8');
    const c = parseQuestion(clipped);
    assert.deepEqual(c.options, ['Only the carousel applies it (Recommended)', 'Show the swatch everywhere', 'Unpick when the panel opens', 'Type something.', 'Chat about this']);
    assert.deepEqual(c.descriptions.slice(3), ['', ''], 'no scroll marker as a description');
    assert.match(c.question, /^be picked, .* How should those other routes behave\?$/);
    assert.ok(questionOpen(clipped), 'a typed message cancels it (Esc) rather than being refused');

    // A tool permission prompt, captured from a real Claude Code: an "Esc to cancel" footer, the command as the question
    const perm = readFileSync(new URL('../fixtures/permission-bash.txt', import.meta.url), 'utf8');
    const p = parseQuestion(perm);
    assert.equal(p.question, 'Bash command · Write and remove a test file · Do you want to proceed?');
    assert.equal(p.detail, 'echo hi > out-from-test.txt && rm out-from-test.txt', 'the command, apart from the question');
    assert.equal(p.risky, false);
    assert.deepEqual(p.options, ['Yes', "Yes, and don't ask again for echo hi and rm out-from-test.txt commands in", 'Yes, and switch to auto mode · auto mode handles these prompts for you', 'No']);
    assert.equal(p.selected, 0);
    assert.match(p.descriptions[1], /-to-wrap-it-x\/0123456789abcdef-4f82c6fe07ad\/scratchpad\/perm$/, 'a path cut at the pane edge is joined back');
    const boxed = perm.split('\n').map(l => `│ ${l.padEnd(100)} │`).join('\n');
    assert.deepEqual(parseQuestion(boxed), p, '│ box borders are stripped');
    assert.equal(parseQuestion(perm.replace('Esc to cancel · Tab to amend', 'Esc to cancel · Tab to amend\n\n❯ next prompt\n\nmore\nand more')), null, 'the footer must be at the bottom');
    r = await run([perm, perm.replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No'), 'Denied'], 3, 'No');
    assert.equal(r.err, null);
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Down', 'Down', 'Down'], ['Enter']], 'answered by the same ❯ path');
    const edit = readFileSync(new URL('../fixtures/permission-edit.txt', import.meta.url), 'utf8');
    assert.equal(parseQuestion(edit).question, 'Edit file · foo.js · Do you want to make this edit to foo.js?');
    assert.equal(parseQuestion(edit).detail, '1  const a = 1;\n2 -const b = 2;\n2 +const b = 3;\n3  console.log(a + b);', 'the diff is the detail');
    // a command past 4 lines used to be dropped: approved blind. Now all of it, its indentation kept, and the risky parts flagged
    const longPane = readFileSync(new URL('../fixtures/permission-bash-long.txt', import.meta.url), 'utf8');
    const longCmd = parseQuestion(longPane);
    assert.equal(longCmd.question, 'Bash command · Rebase onto main and force-push the branch · Do you want to proceed?');
    assert.equal(longCmd.detail.split('\n').length, 8);
    assert.equal(longCmd.detail.split('\n')[6], '  git push --force origin feature &&');
    assert.equal(longCmd.risky, true);
    r = await run([longPane, longPane.replace('glab mr merge 42', 'glab mr merge 43')], 3, 'No');
    assert.ok(!r.sent.some(a => a.includes('Enter')));
    assert.equal(r.err.status, 409, 'a command that changed under the arrows is not answered');
    // the answer carries a hash of what the card showed: only that exact prompt is approved
    const swapped = longPane.replace('glab mr merge 42', 'glab mr merge 43');
    assert.notEqual(seenHash(longCmd), seenHash(parseQuestion(swapped)));
    assert.equal(seenHash(longCmd), seenHash({ question: longCmd.question, detail: longCmd.detail }), 'stable');
    const answerSeen = async (pane, seen) => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: pane } : void sent.push(a));
        const err = await answerQuestion('cc-new-probe', 0, 'Yes', { tm, nap: async () => {}, seen }).then(() => null, e => e);

        return { sent, err };
    };
    r = await answerSeen(swapped, seenHash(longCmd));
    assert.deepEqual([r.err?.status, r.err?.message, r.sent], [409, 'The command changed — check it again', []], 'a replaced command is refused before any key');
    r = await answerSeen(longPane, seenHash(longCmd));
    assert.deepEqual(r.sent.map(a => a.slice(3)), [['Enter']], 'the command seen is approved');
    assert.deepEqual(parseQuestion(edit).options, ['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this', 'No']);
    console.log('ok ask question');
}

{
    // Chat image uploads: allowed types only, 10 MB cap (also mid-stream), a generated name, and a serve-name check
    const dir = mkdtempSync(join(tmpdir(), 'homebase-uploads-'));
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const status = p => p.then(() => null, e => e.status);
    for (const type of ['text/html', 'image/svg+xml', 'application/octet-stream', undefined, '']) {
        assert.equal(await status(saveUpload([png], type, png.length, dir)), 415, String(type));
    }
    assert.equal(await status(saveUpload([png], 'image/png', UPLOAD_MAX + 1, dir)), 413, 'declared length');
    let read = 0;
    const big = (function* () { for (let i = 0; i < 20; i++) { read++; yield Buffer.alloc(1024 * 1024); } })();
    assert.equal(await status(saveUpload(big, 'image/png', undefined, dir)), 413, 'streamed length');
    assert.equal(read, 11, 'stops reading past the cap');
    assert.equal(await status(saveUpload([], 'image/png', 0, dir)), 400);
    assert.deepEqual(readdirSync(dir), [], 'nothing stored for a refused upload');

    const path = await saveUpload([png], 'image/png; charset=binary', png.length, dir);
    const name = path.slice(dir.length + 1);
    assert.equal(path, join(dir, name));
    assert.match(name, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    assert.match(await saveUpload([png], 'IMAGE/JPEG', 8, dir), /\.jpg$/);
    assert.deepEqual(await readUpload(name, dir), { type: 'image/png', body: png });
    assert.equal(await readUpload(name.replace('.png', '.gif'), dir), null, 'missing file');
    for (const bad of ['../items.json', `..%2F${name}`, `../uploads/${name}`, `${name}/..`, name.replace('.png', '.svg'), `a${name}`, '%2e%2e%2fitems.json', '']) {
        assert.ok(!UPLOAD_NAME.test(bad), bad);
        assert.equal(await readUpload(bad, dir), null, bad);
    }
    rmSync(dir, { recursive: true, force: true });
    console.log('ok uploads');
}

{
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    assert.equal(pasteLabel(3, long), '[Pasted text #3 +12 lines]');
    assert.ok(isLongPaste(long) && isLongPaste('x'.repeat(801)) && !isLongPaste('a\nb'));
    assert.equal(expandPastes(`see ${pasteLabel(3, long)} and [Pasted text #9 +2 lines]`, { 3: long }), `see ${long} and [Pasted text #9 +2 lines]`, 'unknown labels stay as typed');
    console.log('ok paste labels');
}

{
    const q = '│ What bothers you?\n❯ 1. [✔] Logo looks bad\n  2. [ ] Too plain\n     Next\n  6. Chat about this\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n';
    const trust = ' Accessing workspace:\n /x\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel\n';
    assert.ok(questionOpen(q) && !questionOpen(trust) && !questionOpen('❯ hello\n'));
    const run = async panes => {
        const sent = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void sent.push(a));
        const r = await cancelQuestion('cc-new-x', { tm, nap: async () => {} }).catch(e => e);
        return { r, sent };
    };
    let { r, sent } = await run(['idle']);
    assert.equal(r, false); assert.deepEqual(sent, []);
    ({ r, sent } = await run([q, q, 'declined']));
    assert.equal(r, true); assert.deepEqual(sent, [['send-keys', '-t', '=cc-new-x:', 'Escape']]);
    ({ r } = await run([q]));
    assert.equal(r.status, 502, 'still open');
    assert.equal((await cancelQuestion('zsh', { tm: async () => ({ stdout: q }) }).catch(e => e)).status, 400);

    const { confirmModelSwitch } = await import('../../server/startup.mjs');
    const sw = readFileSync(new URL('../fixtures/dialog-switch-model.txt', import.meta.url), 'utf8');
    const confirm = async panes => {
        const keys = [];
        const tm = async a => (a[0] === 'capture-pane' ? { stdout: panes.length > 1 ? panes.shift() : panes[0] } : void keys.push(a));
        return { ok: await confirmModelSwitch('cc-new-x', { tm, nap: async () => {} }), keys };
    };
    assert.deepEqual(await confirm(['❯ /model fable', sw]), { ok: true, keys: [['send-keys', '-t', '=cc-new-x:', 'Enter']] }, 'the dialog, once drawn, is confirmed with one Enter');
    assert.deepEqual(await confirm([sw.replace('❯ 1.', '  1.').replace('  2. No', '❯ 2. No')]), { ok: false, keys: [] }, 'the ❯ is not on Yes: left to the card');
    assert.deepEqual(await confirm([q]), { ok: false, keys: [] }, 'another dialog is never answered');
    assert.deepEqual(await confirm([sw.replace('Yes, switch to', 'Yes, delete')]), { ok: false, keys: [] }, 'nor one with another first option');
    assert.deepEqual(await confirm(['idle']), { ok: false, keys: [] }, 'no dialog within the wait: nothing pressed');
    // the same dialog with its "Enter to confirm · Esc to cancel" footer drawn (a real chat got stuck on it)
    const swFooter = readFileSync(new URL('../fixtures/dialog-switch-model-footer.txt', import.meta.url), 'utf8');
    assert.deepEqual(parseQuestion(swFooter)?.options, ['Yes, switch to Opus 5.5', 'No, go back']);
    assert.deepEqual(await confirm(['❯ /model opus', swFooter]), { ok: true, keys: [['send-keys', '-t', '=cc-new-x:', 'Enter']] }, 'with its footer too');
    console.log('ok cancel question');
}

{
    assert.equal(loginShell('/usr/bin/fish'), '/usr/bin/fish', '$SHELL wins');
    assert.equal(loginShell('', p => p === '/bin/bash'), '/bin/bash', 'no $SHELL and no zsh: bash');
    assert.equal(loginShell('', () => false), '/bin/sh', 'sh as the last resort');
    assert.equal(claudeLine(' --resume x', '/nope/rules.md'), 'claude --resume x', 'no rules file: plain claude');
    assert.match(claudeLine(' --resume x', undefined, false), /^claude --append-system-prompt-file '.*\/homebase-rules(\.local)?\.md' --resume x$/);
    const d = mkdtempSync(join(tmpdir(), 'rf-'));
    assert.equal(rulesFile(d), join(d, 'homebase-rules.md'), 'tracked file by default');
    writeFileSync(join(d, 'homebase-rules.local.md'), 'mine');
    assert.equal(rulesFile(d), join(d, 'homebase-rules.local.md'), 'the local file wins when it exists');
    console.log('ok claude line');
}

{
    // Token saver: the one rule chats get, on and off
    assert.match(saverRules(true), /^Token saver is on: start every helper \(Agent tool\) with model: sonnet, unless the user names another model\. Run at most two helpers at a time; do small jobs \(a lookup, a few-line fix\) yourself instead of starting a helper\. Queue further work and start it when a helper finishes\.$/);
    assert.ok(!saverRules(false).includes('sonnet') && saverRules(false).startsWith('Token saver is off'));
    const on = claudeLine(' --resume x', '/nope/rules.md', true);
    assert.equal(on, `claude --append-system-prompt '${SAVER_RULE}' --resume x`, 'on: the rule is added as text');
    assert.equal(claudeLine(' --resume x', '/nope/rules.md', false), 'claude --resume x', 'off: nothing added');
    const dir = mkdtempSync(join(tmpdir(), 'saver-'));
    assert.equal(saverOn(dir), false, 'off by default');
    await saveSaver('{"on":true}', dir);
    assert.equal(saverOn(dir), true);
    assert.equal(readFileSync(join(dir, 'token-saver.md'), 'utf8').trim(), SAVER_RULE, 'the file a stale chat re-reads says the rule');
    await saveSaver('{"on":false}', dir);
    assert.equal(saverOn(dir), false);
    await assert.rejects(saveSaver('{"on":"yes"}', dir), e => e.status === 400);
    // auto-on at 80% used, either window; the user's choice stays separate; the file changes only on a flip
    const lim = (five, week) => ({ fiveHour: { used: five }, sevenDay: { used: week } });
    assert.deepEqual(await syncSaver(lim(79, 10), dir), { on: false, auto: false, effective: false, used: 79 });
    assert.equal(saverOn(dir), false);
    assert.equal((await syncSaver(lim(10, 80), dir)).effective, true, 'weekly at 80 turns it on');
    assert.equal(saverOn(dir), true);
    const at = statSync(join(dir, 'token-saver.md')).mtimeMs;
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(await syncSaver(lim(95, 10), dir), { on: false, auto: true, effective: true, used: 95 });
    assert.equal(statSync(join(dir, 'token-saver.md')).mtimeMs, at, 'no rewrite without a flip');
    assert.equal((await saveSaver('{"on":true}', dir, lim(10, 10))).effective, true);
    assert.equal((await syncSaver(lim(10, 10), dir)).auto, false);
    assert.equal(saverOn(dir), true, 'the user choice holds when usage drops');
    assert.equal((await saveSaver('{"on":false}', dir, lim(10, 10))).effective, false);
    rmSync(dir, { recursive: true });
    console.log('ok token saver rules');
}

{
    // a failed git lookup gives the folder name but is not cached; a good one is, and every call gets a timeout
    let calls = 0, opts;
    const bad = async () => { calls++; throw new Error('timed out'); };
    assert.equal(await projectOf('/x/y/proj-a', bad), 'proj-a');
    await projectOf('/x/y/proj-a', bad);
    assert.equal(calls, 4, 'asked git again (2 commands per call)');
    const good = async (_c, _a, o) => { opts = o; calls++; return { stdout: 'git@h:g/repo-b.git\n' }; };
    calls = 0;
    assert.equal(await projectOf('/x/y/proj-b', good), 'repo-b');
    await projectOf('/x/y/proj-b', bad);
    assert.equal(calls, 1);
    assert.equal(opts.timeout, 5000);
    console.log('ok projectOf no cache on failure');
}
