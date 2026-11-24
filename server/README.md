# server/

`../server.mjs` is the entry point: config (env vars), startup and the router. It re-exports every function the tests use, so the unit tests in `tests/unit/` import mostly from `../../server.mjs`.

| Module | What lives there |
|---|---|
| `transcripts.mjs` | `transcript()` for `/api/transcript`, `agentFeed()` for `/api/agent-feed` (a helper's own feed, for Step in); re-exports the six transcript modules below |
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
| `reviewer.mjs` | Review chats: POST `/api/reviewer?key=` starts a read-only reviewer Claude (own `cc-<id8>` tmux, fixed prompt) in an in-review row's checkout; `/api/reviewer/sent` marks its findings sent; `reviewers.json` in the Homebase dir maps row key to chat (the button states: `reviewAction` in `items.mjs`) |
| `helpers.mjs` | Work helpers as their own chats, driven by `bin/homebase.mjs helper start/read/list/stop/send/wait` from inside a chat's tmux: `/api/helpers` (POST `start` with the brief as body, GET list and `/<id>`, POST `stop`, POST `send` through `control.mjs` `send()`; `wait` polls GET `/<id>` every 5 s), `startHelper` (worktree `helper/<slug>` from the parent's HEAD, own `cc-<id8>` tmux, `HELPER_RULE`, 4 per parent and 8 in all), `closeHelper` (kills only its tmux, `git worktree remove` without `--force`, `git branch -d`), `helpers.json` and the owner-only `token` file in the Homebase dir |
| `saver.mjs` | Token saver: GET/POST `/api/saver`, `token-saver.md` in the Homebase dir (the setting, and the rule a stale chat re-reads); `claudeLine` adds its rule so helpers run on Sonnet |
| `checks.mjs` | Checks before done: GET/POST `/api/checks?project=` (`{commands: [...]}` in `checks.json` in the Homebase dir; set with `curl -X POST -H 'x-codetool: 1' -H 'x-homebase-token: <token>' -d '{"commands":["npm test"]}' 'localhost:<port>/api/checks?project=<repo>'`), the Stop hook logic behind `hooks/checks.mjs` (runs only when the git state changed since the last pass, blocks up to 3 identical failures), `--settings` file for `claudeLine`, per-session `checks/<id>.json` for the row's chip |
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
| `gitpush.mjs` | The header Push button: POST `/api/push`, pushes the session's own branch (never forced; a work repo's default branch, main and master refused) |
| `reload.mjs` | Update without restarts: `/api/version` (server code newer than at start, browser-file mtime hash), POST `/api/server/reload` replacing the process, bind retry |
| `static.mjs` | App file map, build hash, CSP, `public/vendor` serving, revalidation, the Vue islands (`/web/main.js` and `/web/main.css` from `web/dist`, their tags in `index.html` only once built; see `web/README.md`) |

Imports only go one way, with no cycles:
`saver`, `checks`, `security`, `pairing`, `static`, `uploads`, `tracked`, `push`, `reload`, `limits` and `usage` import no other module; `forge` neither.
`tmux` → saver, checks.
`entries` → tmux.
`summaries` → entries.
`asks` → summaries.
`feed` → entries, summaries, asks.
`turns` → entries, tmux, startup.
`transcripts` → entries, feed, turns (and re-exports all six).
`items` → entries, usage, forge.
`sessions` → checks, entries, summaries, feed, turns, usage, forge, items, tmux.
`milestones` → forge, items, sessions.
`reviews` → forge, account.
`log` → entries, summaries, usage, forge, sessions.
`control` → entries, sessions, tmux.
`diff` → sessions.
`gitpush` → sessions (and `sessions` → `gitpush`, for `pushBlocked`).
`newproject` → entries, tmux, startup, sessions.
`startup` → tmux, summaries.
`helpers` → account, items, tmux, startup, summaries.

Module state (caches, maps) lives in exactly one module and is imported, never copied.
