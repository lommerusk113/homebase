// Unit tests: one file per area under tests/unit/, run one after another in this order.
// Each prints `ok <name>` per passing group; a failing assert rejects the import and fails the run.
const UNITS = [
    'agents', 'answered-once', 'chat', 'items', 'kinds', 'comments', 'asks', 'usage', 'milestones', 'turns', 'board', 'security', 'http',
    'client', 'links', 'transcripts', 'projects', 'accounts', 'forge', 'queue', 'sessions', 'send', 'questions', 'push',
    'diff', 'gitpush', 'setup', 'forge-rows', 'robustness', 'checks', 'web', 'review-chat', 'start', 'work-helpers', 'states', 'autoretry', 'worktrees',
];

for (const unit of UNITS) {
    await import(`./tests/unit/${unit}.mjs`);
}
