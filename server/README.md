# server/

`../server.mjs` is the entry point: config (env vars), startup and the router. It re-exports every function the tests use, so the unit tests in `tests/unit/` import mostly from `../../server.mjs`.

| Module | What lives there |
|---|---|
| `transcripts.mjs` | `transcript()` for `/api/transcript`, `agentFeed()` for `/api/agent-feed` (an in-process subagent's own feed, read-only from its row); re-exports the six transcript modules below |
| `entries.mjs` | The projects root, live Claude Code sessions (`liveSessions`), tail reading and its mtime cache, entry cleanup, text and prompt helpers |
| `summaries.mjs` | A reply or tail at a glance: ▸ topic, TLDR, queued prompts, review-gate runs, tool-call summaries, `RISKY` commands |
| `feed.mjs` | The chat feed: entries turned into bubbles, answers paired with questions, handled replies, `feedTail` for "Show earlier" |
| `asks.mjs` | What a reply asks of you: Waiting on you, option lists and chip labels, quick replies, `topicAndTldr` |
| `turns.mjs` | Turn state (with the `hooks/asking.mjs` marker; a registry-busy chat whose pane `startup.mjs` `paneIdle` calls idle goes into `live.idle` through `markIdle` and counts as idle), pending AskUserQuestion and permission waits, closed sessions, turn and spawn prompts |
| `usage.mjs` | Token usage read by byte offset, duration and token formatting |
| `sessions.mjs` | Repo names, subagent summaries and status, session summaries, `sessions()`, and `polledSessions()` (one shared build, reused for a second) for `/api/sessions` |
| `items.mjs` | Work-item rules (pure): columns, lifecycle, next step, row action, gate badge, milestone of an MR |
| `forge.mjs` | glab/gh calls: PR/MR state, `mergeMr` and `rebaseMr` (the only writes, behind the queue and POST `/api/rebase` for a row with that button), comments and threads, limiter, dedupe, the `prs` and `swr` caches, refresh button |
| `reviews.mjs` | MRs by others that ask me for a review (`/api/reviews`), read-only, cached |
| `milestones.mjs` | Milestones tab: milestone lists, issue groups, linked MRs, start-up warm-up |
| `log.mjs` | Activity log (☰ → Activity log…): finished subagents, git commits, chat topics and closed MRs of a project's last 7 days, `log()` for `/api/log` |
| `limits.mjs` | Rate limits from the status-line dumps |
| `pins.mjs` | Rows moved to another group by hand: POST `/api/pins?key=&column=&fp=` (`column=auto` drops it); `pins.json` in the Homebase dir; `items.mjs` `withPin` shows the pinned group until the row's `fp` (fingerprint of its computed state) changes |
| `reviews.mjs` (findings part) | `reviewFindings`: a Review requested row's review chat, once idle with a reply, offers Send findings / Approve (verdict ready); POST `/api/reviews/sent {url, sha}` records it in `reviews-sent.json`, shown as "Findings sent" until the head moves |
| `reviewer.mjs` | Review chats: POST `/api/reviewer?key=` starts a read-only reviewer Claude (own `cc-<id8>` tmux, fixed prompt) in an in-review row's checkout; `/api/reviewer/sent` marks its findings sent; `reviewers.json` in the Homebase dir maps row key to chat (the button states: `reviewAction` in `items.mjs`) |
| `actions.mjs` | The MR row buttons Rebase (a real conflict), Fix pipeline and Fix & reply: `startActionHelper(dir, mr, action, list)` starts a fresh helper (through `startHelper`, worktree from `origin/<source branch>`, title naming the MR so its row nests under the MR's) with `actionBrief`'s fixed brief (MR URL, ref, title, branches, the job, the project's own rules, `homebase status`, and the owning chat's transcript path to read only if needed); one per MR and action, a repeat returns the running one; POST `/api/action?key=` calls it, and the merge queue can too; `owningChat` picks the chat on the branch, else the row's |
| `helpers.mjs` | Work helpers as their own chats, driven by `bin/homebase.mjs helper start/read/list/stop/send/wait` from inside a chat's tmux: `/api/helpers` (POST `start` with the brief as body, GET list and `/<id>`, POST `stop`, POST `send` through `control.mjs` `send()`; `wait` polls GET `/<id>` every 5 s and returns once a helper seen at a turn, or with a reply newer than the wait, ends it, or closes), `startHelper` (worktree `helper/<slug>` from the parent's HEAD, own `cc-<id8>` tmux, `HELPER_RULE`, 4 per parent and 8 in all; the parent is its chat's tmux, so it stays the parent across `/clear`), `closeHelper` (kills only its tmux, `git worktree remove` without `--force`, `git branch -d`), `nestHelpers` (the helper's chat gets `parentId`, its parent an agent with `helperSession`, so the board nests its row; a closed one is read-only, `send()` refuses it), `reapHelpers` (at start and every 60 s through `closeHelper`, registered helpers only: pure `reapDecisions` closes one whose claude exited, whose parent is gone 10 min while it doesn't work, idle 30 min, or waiting on you 24 h), `helpers.json` and the owner-only `token` file in the Homebase dir |
| `reports.mjs` | What chats report with `homebase status doing\|needs-you\|done --mr <MR> "<text>"` (POST `/api/status?parent=<tmux>`): `--mr` resolved once to the MR's URL by the chat's forge (`!N` on GitLab, `#N` on GitHub, a URL cut to the MR); session id -> `{ phase, mr, text, at }` in `reports.json` in the Homebase dir; `sessions.mjs` `attachReports` says when one counts and deletes it when it ends; `items.mjs` links the chat to the MR by URL |
| `sendlog.mjs` | Homebase's own notes typed into a chat ("Load new rules", `/api/send?housekeeping=1`), per chat in `sends.json`: a prompt with one of those texts answers nothing (feed, reports) |
| `autoretry.mjs`, `autosend.mjs` | Automatic Continue: `autoContinue` (run by `sessions()` before the rows are built) sends the canned Continue to a live chat/helper/subagent stopped on a transient API error (30 s, 2 min, 5 min, reset after 10 min), a rate-limit stop only when its text names the reset, and a silent subagent up to 3 times 60 s apart; marks `retry` for the row ("Retrying (2/3)…"); `retries.json` in the Homebase dir. `autosend.mjs` is the sender `server.mjs` registers (control.mjs `send()`), logging each text through `sendlog.mjs` first |
| `worktrees.mjs` | Issue worktree cleanup (`cleanupWorktrees`, at start and every 5 min from `server.mjs`): `<repo>/.claude/worktrees/<iid>-<slug>` (what `start.mjs` makes) of a merged or closed GitLab MR is removed with `git worktree remove` (never `--force` or rm) only when clean (no uncommitted or untracked files, nothing unpushed: HEAD inside the MR's last head, or on a remote) and no chat or tmux session uses it, then `git branch -d`; otherwise kept and the reason logged once |
| `queue.mjs` | The merge queue (the Merge button): `queueStep` (what the head of a line does), `advanceQueue` (run on every board poll: GitLab rebase, merge, leave with a reason; a conflict or failed pipeline starts the row's fix helper through `actions.mjs` `startActionHelper` (a running one is reused) and the MR waits in the queue while the next of its line goes), `restoreQueue` (from items.json's `queued`) |
| `once.mjs` | A row button's double-send guard (`claim`, 2 min per row and state kind) and its click hold: `sentRows` keeps a clicked row in Doing while its kind is unchanged, for `HOLD_MS` (30 min) at most, saved in `sent.json` in the Homebase dir so a restart keeps it (rules: `docs/row-states.md`) |
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
`saver`, `reports`, `sendlog`, `once`, `checks`, `security`, `pairing`, `static`, `uploads`, `tracked`, `push`, `reload`, `limits` and `usage` import no other module; `forge` neither.
`tmux` → saver, checks.
`entries` → tmux.
`summaries` → entries.
`asks` → summaries.
`feed` → entries, summaries, asks, sendlog.
`turns` → entries, tmux, startup.
`transcripts` → entries, feed, turns (and re-exports all six).
`items` → entries, usage, forge, once, reports.
`sessions` → checks, reports, entries, summaries, feed, turns, usage, forge, items, tmux.
`milestones` → forge, items, sessions.
`reviews` → forge, account.
`log` → entries, summaries, usage, forge, sessions.
`control` → entries, sessions, tmux.
`diff` → sessions.
`gitpush` → sessions (and `sessions` → `gitpush`, for `pushBlocked`).
`newproject` → entries, tmux, startup, sessions.
`startup` → tmux, summaries.
`helpers` → account, items, tmux, startup, summaries.
`actions` → entries, forge, tmux, helpers.
`queue` → forge, actions through the starter `sessions` hands `advanceQueue`.

Module state (caches, maps) lives in exactly one module and is imported, never copied.
