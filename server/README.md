# server/

`../server.mjs` is the entry point: config (env vars), startup and the router. It re-exports every function the tests use, so `test.mjs` imports only from `./server.mjs`.

| Module | What lives there |
|---|---|
| `transcripts.mjs` | Tail reading and its mtime cache, chat bubbles, TLDR/topic, turn state, review-gate runs, token usage, `transcript()` for `/api/transcript` |
| `sessions.mjs` | Repo names, subagent summaries and status, session summaries, `sessions()` for `/api/sessions`, `folderFor` |
| `items.mjs` | Work-item rules (pure): columns, lifecycle, next step, row action, gate badge, milestone of an MR |
| `forge.mjs` | glab/gh calls: PR/MR state, comments and threads, limiter, dedupe, the `prs` and `swr` caches, refresh button |
| `milestones.mjs` | Milestones tab: milestone lists, issue groups, linked MRs, start-up warm-up |
| `log.mjs` | Log tab: finished subagents, git commits, chat topics and closed MRs of a project's last 7 days, `log()` for `/api/log` |
| `limits.mjs` | Rate limits from the status-line dumps |
| `tmux.mjs` | tmux plumbing: socket override, session names, `/clear` aliases, keystroke steps |
| `control.mjs` | POST actions: send, interrupt, `/clear`, open in editor |
| `newproject.mjs` | POST `/api/projects/new`: config merge, name check, the create/clone/start-chat steps with the keychain token kept out of every output |
| `security.mjs` | Host/Origin/token checks, LAN pairing cookie and code, rate limiter |
| `static.mjs` | App file map, build hash, CSP, `public/vendor` serving, revalidation |

Imports only go one way, with no cycles:
`transcripts`, `tmux`, `security`, `static` and `limits` import no other module; `forge` neither.
`items` → transcripts, forge.
`sessions` → transcripts, forge, items, tmux.
`milestones` → forge, items, sessions.
`log` → transcripts, forge, sessions.
`control` → sessions, tmux.
`newproject` → transcripts, tmux.

Module state (caches, maps) lives in exactly one module and is imported, never copied.
