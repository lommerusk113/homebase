// Unit tests: one file per area under tests/unit/, run one after another in this order.
// Each prints `ok <name>` per passing group; a failing assert rejects the import and fails the run.
const UNITS = [
    'agents', 'chat', 'items', 'comments', 'asks', 'usage', 'milestones', 'turns', 'board', 'security', 'http',
    'client', 'links', 'transcripts', 'projects', 'accounts', 'forge', 'sessions', 'send', 'questions', 'push',
    'diff', 'gitpush', 'setup', 'forge-rows', 'robustness', 'web', 'review-chat', 'start',
];

for (const unit of UNITS) {
    await import(`./tests/unit/${unit}.mjs`);
}
