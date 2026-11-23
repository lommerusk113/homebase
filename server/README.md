# server/

`../server.mjs` is the entry point: config (env vars), startup and the router. It re-exports every function the tests use, so `test.mjs` imports only from `./server.mjs`.

| Module | What lives there |
|---|---|
| `transcripts.mjs` | `transcript()` for `/api/transcript`; re-exports the six transcript modules below |
| `entries.mjs` | The projects root, live Claude Code sessions (`liveSessions`), tail reading and its mtime cache, entry cleanup, text and prompt helpers |
| `summaries.mjs` | A reply or tail at a glance: ▸ topic, TLDR, queued prompts, review-gate runs, tool-call summaries, `RISKY` commands |
| `feed.mjs` | The chat feed: entries turned into bubbles, answers paired with questions, handled replies, `feedTail` for "Show earlier" |
| `asks.mjs` | What a reply asks of you: Waiting on you, option lists and chip labels, quick replies, `topicAndTldr` |
| `turns.mjs` | Turn state (with the `hooks/asking.mjs` marker), pending AskUserQuestion and permission waits, closed sessions, turn and spawn prompts |
| `usage.mjs` | Token usage read by byte offset, duration and token formatting |
| `sessions.mjs` | Repo names, subagent summaries and status, session summaries, `sessions()`, and `polledSessions()` (one shared build, reused for a second) for `/api/sessions` |
| `items.mjs` | Work-item rules (pure): columns, lifecycle, next step, row action, gate badge, milestone of an MR |
| `forge.mjs` | glab/gh calls: PR/MR state, comments and threads, limiter, dedupe, the `prs` and `swr` caches, refresh button |
| `reviews.mjs` | MRs by others that ask me for a review (`/api/reviews`), read-only, cached |
| `milestones.mjs` | Milestones tab: milestone lists, issue groups, linked MRs, start-up warm-up |
| `log.mjs` | Activity log (☰ → Activity log…): finished subagents, git commits, chat topics and closed MRs of a project's last 7 days, `log()` for `/api/log` |
| `limits.mjs` | Rate limits from the status-line dumps |
| `tmux.mjs` | tmux plumbing: socket override, session names, `/clear` aliases, keystroke steps |
| `control.mjs` | POST actions: send, interrupt, `/clear` |
| `startup.mjs` | Blocking Claude Code startup dialogs and AskUserQuestion prompts in a `cc-*` tmux pane: parse the capture, answer an option, trust the new project's own folder |
| `account.mjs` | which GitHub account a repo's gh calls run as (keychain token for personal repos), the shared token reader, config merge |
| `newproject.mjs` | POST `/api/projects/new`, `/clone` and `/open`, GET `/github` and `/local`: name check, the create/clone/start-chat steps, the folder check for Open, the owner's repo list with the keychain token kept out of every output |
| `uploads.mjs` | Chat image uploads: POST `/api/upload` (type and size checks, generated name), GET `/api/upload/<name>` |
| `push.mjs` | Web Push: VAPID keys and JWT, RFC 8291 encryption, sending, `subscriptions.json`, the asking/needs-you transition watcher behind POST `/api/push/subscribe` and `/unsubscribe` |
| `security.mjs` | Host/Origin/token checks, the local host list |
| `pairing.mjs` | Remote access through `tailscale serve`: the `remote` config, the remote port test, one-time codes and their rate limit, device cookies (hashes in `devices.json`), revoke, the pair page, `isPairedRequest(req)` for other features |
| `tracked.mjs` | The board's projects, GET/POST `/api/tracked` (`tracked.json`), shared by the Mac and its paired devices |
| `diff.mjs` | Changes view: GET `/api/diff`, the folder of a session or of an item's worktree, the changed-file lists (git status and diff parsing) and one file's diff, read-only with size caps |
| `reload.mjs` | Update without restarts: `/api/version` (server code newer than at start, browser-file mtime hash), POST `/api/server/reload` replacing the process, bind retry |
| `static.mjs` | App file map, build hash, CSP, `public/vendor` serving, revalidation |

Imports only go one way, with no cycles:
`tmux`, `security`, `pairing`, `static`, `uploads`, `tracked`, `push`, `reload`, `limits` and `usage` import no other module; `forge` neither.
`entries` → tmux.
`summaries` → entries.
`asks` → summaries.
`feed` → entries, summaries, asks.
`turns` → entries, tmux, startup.
`transcripts` → entries, feed, turns (and re-exports all six).
`items` → entries, usage, forge.
`sessions` → entries, summaries, feed, turns, usage, forge, items, tmux.
`milestones` → forge, items, sessions.
`reviews` → forge, account.
`log` → entries, summaries, usage, forge, sessions.
`control` → entries, sessions, tmux.
`diff` → sessions.
`newproject` → entries, tmux, startup, sessions.
`startup` → tmux, summaries.

Module state (caches, maps) lives in exactly one module and is imported, never copied.
