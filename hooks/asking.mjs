// Claude Code hook: keeps ~/.claude/homebase/asking/<session>.json while a session waits on the user, so Homebase sees
// an AskUserQuestion whose transcript entry Claude Code only writes once it is answered. Install: see README.md.
// Never fails the hook and prints nothing: Claude Code must not change course because of it.
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

process.umask(0o077); // the markers hold question text and permission messages: owner-only, like the rest of the Homebase dir
try {
    const h = JSON.parse(readFileSync(0, 'utf8'));
    if (SESSION_ID.test(h.session_id ?? '')) {
        const dir = join(process.env.HOMEBASE_DIR ?? join(homedir(), '.claude', 'homebase'), 'asking');
        const file = join(dir, `${h.session_id}.json`);
        const write = marker => {
            mkdirSync(dir, { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ ...marker, at: new Date().toISOString() }));
            renameSync(tmp, file);
        };
        const marker = () => {
            try {
                return JSON.parse(readFileSync(file, 'utf8'));
            } catch {
                return null;
            }
        };

        const ev = h.hook_event_name;
        if (ev === 'PreToolUse' && h.tool_name === 'AskUserQuestion') {
            const questions = (h.tool_input?.questions ?? []).map(q => ({ question: String(q.question ?? ''), options: (q.options ?? []).map(o => String(o.label ?? '')).filter(Boolean) }));
            write({ questions, toolUseId: h.tool_use_id ?? null });
        } else if (ev === 'Notification' && h.notification_type === 'permission_prompt') {
            write({ permission: String(h.message || 'Claude needs your permission') });
        } else if (ev === 'UserPromptSubmit' || ev === 'Stop') {
            rmSync(file, { force: true });
        } else if (ev === 'PostToolUse' && !h.agent_id) {
            // a tool that ran in the same message as the question (a background Agent) doesn't answer it;
            // ponytail: subagent tools never clear, so a subagent's permission marker waits for the main chat's next tool or Stop
            if (h.tool_name === 'AskUserQuestion' || marker()?.permission) {
                rmSync(file, { force: true });
            }
        }
    }
} catch {}

process.exit(0);
