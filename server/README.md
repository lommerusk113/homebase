# server/

`../server.mjs` is the entry point: config (env vars), startup and the router. It re-exports every function the tests use, so `test.mjs` imports only from `./server.mjs`.

| Module | What lives there |
|---|---|
| `transcripts.mjs` | Tail reading and its mtime cache, chat bubbles, TLDR/topic, turn state (with the `hooks/asking.mjs` marker), review-gate runs, token usage, `transcript()` for `/api/transcript` |
| `sessions.mjs` | Repo names, subagent summaries and status, session summaries, `sessions()` for `/api/sessions`, `folderFor` |
| `items.mjs` | Work-item rules (pure): columns, lifecycle, next step, row action, gate badge, milestone of an MR |
| `forge.mjs` | glab/gh calls: PR/MR state, comments and threads, limiter, dedupe, the `prs` and `swr` caches, refresh button |
| `milestones.mjs` | Milestones tab: milestone lists, issue groups, linked MRs, start-up warm-up |
| `log.mjs` | Log tab: finished subagents, git commits, chat topics and closed MRs of a project's last 7 days, `log()` for `/api/log` |
| `limits.mjs` | Rate limits from the status-line dumps |
| `tmux.mjs` | tmux plumbing: socket override, session names, `/clear` aliases, keystroke steps |
| `control.mjs` | POST actions: send, interrupt, `/clear`, open in editor |
| `startup.mjs` | Blocking Claude Code startup dialogs and AskUserQuestion prompts in a `cc-*` tmux pane: parse the capture, answer an option, trust the new project's own folder |
| `account.mjs` | which GitHub account a repo's gh calls run as (keychain token for personal repos), the shared token reader, config merge |
| `newproject.mjs` | POST `/api/projects/new`, `/clone` and `/open`, GET `/github` and `/local`: name check, the create/clone/start-chat steps, the folder check for Open, the owner's repo list with the keychain token kept out of every output |
| `uploads.mjs` | Chat image uploads: POST `/api/upload` (type and size checks, generated name), GET `/api/upload/<name>` |
| `push.mjs` | Web Push: VAPID keys and JWT, RFC 8291 encryption, sending, `subscriptions.json`, the asking/needs-you transition watcher behind POST `/api/push/subscribe` and `/unsubscribe` |
| `security.mjs` | Host/Origin/token checks, the local host list |
| `pairing.mjs` | Remote access through `tailscale serve`: the `remote` config, the remote port test, one-time codes and their rate limit, device cookies (hashes in `devices.json`), revoke, the pair page, `isPairedRequest(req)` for other features |
| `reload.mjs` | Update without restarts: `/api/version` (server code newer than at start, browser-file mtime hash), POST `/api/server/reload` replacing the process, bind retry |
| `static.mjs` | App file map, build hash, CSP, `public/vendor` serving, revalidation |

Imports only go one way, with no cycles:
`transcripts`, `tmux`, `security`, `pairing`, `static`, `uploads`, `push`, `reload` and `limits` import no other module; `forge` neither.
`items` → transcripts, forge.
`sessions` → transcripts, forge, items, tmux.
`milestones` → forge, items, sessions.
`log` → transcripts, forge, sessions.
`control` → sessions, tmux.
`newproject` → transcripts, tmux, startup, sessions.
`startup` → tmux.

Module state (caches, maps) lives in exactly one module and is imported, never copied.
