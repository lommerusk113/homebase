// Claude Code Stop hook (passed with --settings to chats Homebase starts): runs the project's check commands from
// ~/.claude/homebase/checks.json when files changed since the last pass, and blocks the stop with the failure. Logic: server/checks.mjs.
import { readFileSync } from 'node:fs';
import { decide } from '../server/checks.mjs';

process.umask(0o077);
try {
    const out = decide(JSON.parse(readFileSync(0, 'utf8')));
    if (out) {
        process.stdout.write(JSON.stringify(out));
    }
} catch {}

process.exit(0);
