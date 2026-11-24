import assert from 'node:assert/strict';
import { openDecision } from '../../web/src/lib/chat.ts';

// A chip answered while Claude's turn went on is not paired to its question (something sits between them), but the
// strip must not offer the same answer again: it would be sent a second time, wrapped as an "earlier question" answer.
const q = { role: 'assistant', at: 'a1', waiting: 'x', replies: ['Yes (recommended)', 'No'] };
const tools = { role: 'tools', at: 't0', text: 'Bash' }; // a line between the question and the answer keeps them from pairing
assert.equal(openDecision({ items: [q] }), q);
assert.equal(openDecision({ items: [q, tools, { role: 'user', at: 'u1', text: 'Yes (recommended)' }] }), null);
assert.equal(openDecision({ items: [q, tools, { role: 'user', at: 'u1', text: 'Yes (recommended)\n\n(Answering your earlier question from a1: "x")' } ] }), null);
assert.equal(openDecision({ items: [q, tools, { role: 'user', at: 'u1', text: 'Something else' }, ] }), q); // another message does not answer it
console.log('answered-once ok');
console.log('ok answered-once');
