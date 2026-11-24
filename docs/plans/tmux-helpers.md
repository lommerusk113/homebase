# Helpers as their own tmux chats

## Why
The main chat runs work as in-process subagents (Agent tool). The user can't type into them, so Homebase's "step in" asks the main chat to relay text with SendMessage. That workaround keeps breaking: step-in failures, lost relays, Needs you rows that don't say who needs you, and buttons that never reach the helper. Goal: each helper is its own `claude` in its own tmux session. The user can step into it and its buttons go straight to it. The main chat can message one or many helpers and read their state.

## Design

### Start
- `homebase helper start --title "Add paste labels" [--model sonnet] [--base <ref>] [--branch <name>] [--no-worktree] [--wait]`, with the brief on stdin.
- A thin CLI, `bin/homebase.mjs` (node, no dependencies), POSTs to `/api/helpers/start`.
  - Port: from the env or `config.json`.
  - Token: from a new owner-only file `$HOMEBASE_DIR/token` (0600), written at server start. Today `TOKEN` lives only in memory (server.mjs:90).
- The parent is found from the caller's own tmux, not from an argument. The CLI runs `tmux display -p -t "$TMUX_PANE" '#{session_name}'` to get `cc-<id8>`, and the server maps that name to the session whose `s.tmux` matches.
  - A caller that is itself a helper is refused, so helpers don't start helpers.
  - A caller outside Homebase's tmux is refused.
- Worktree: `git -C <parentCwd> worktree add -b helper/<slug> <top>/.claude/worktrees/<slug> <base>`.
  - `<base>` defaults to the parent checkout's HEAD.
  - `<slug>` is the title in kebab-case plus 4 hex characters.
  - `--no-worktree` runs a read-only investigation in the parent's cwd.
- tmux: the same command shape as `startReviewer`:
  `new-session -d -s cc-<id8> -c <worktree> <loginShell> -lic "claudeLine(' --model sonnet -n <title> --session-id <uuid> <brief>')"`.
  `-n` gives the transcript the `custom-title` used as the row title.
- `claudeLine` takes `helper: true`, which adds `HELPER_RULE` through `--append-system-prompt` (built like `MANUAL_RULE`). The rule says:
  - you are a helper; start no work helpers or subagents;
  - commit on your branch; don't push, merge or restart anything;
  - end with a final report of at most 10 lines whose last line is a TLDR;
  - the user may step in and talk to you directly.
- `claudeCmd` (the resume path) looks the helper up in the registry, so a resumed helper keeps its rule and model.
- Folder trust: the start step answers a trust dialog with the existing `trustNewProject`.
- Registry: `server/helpers.mjs` keeps a `helpers` Map plus `helpers.json` in the Homebase dir, saved with reviewer.mjs's save/load pattern. Each entry is `{ id, parent, project, top, cwd, branch, base, title, model, at, closedAt }`.
- Limits: at most 4 running helpers per parent and 8 in total. Above that, start answers 429 with the running list.

### Message and read
- `homebase helper send <id|slug>... [--all]` reads the text from stdin and calls the existing `send(id, text)` in control.mjs for each helper. All of send's safety checks apply, and a refusal is printed per helper.
- `homebase helper read <id> [--full]` prints the status, topic, now/step and any open question, then the last reply's TLDR, or the whole reply with `--full`. It uses `summarize()` through GET `/api/helpers/<id>`.
- `homebase helper list` gives one line per helper of the calling parent: id8, title, status, branch, commits ahead and age.
- `homebase helper stop <id> [--keep-worktree]` closes the helper as described under Lifecycle.

### How the main chat learns a helper finished
- `homebase helper wait <id>...` (or `start --wait`) polls every 5 s. It exits when a helper ends a turn (idle, or closed) and prints that helper's read output.
- The main chat runs it as a background Bash command, so Claude Code's background-command notice wakes it. Homebase never types into the main chat's pane.
- If the helper is asking or waits on the user, `wait` keeps waiting.
- If a woken main chat sees the reply is not a final report, it re-arms `wait`.
- After a restart or `/clear`, the main chat runs `homebase helper list` and re-arms `wait` for each running helper.

### UI
- `sessions()` marks helper sessions with `parentId`. It adds a synthetic agent `{ id, description: title, status, branches, prs, session: true }` to the parent's `agents`, so the existing workItems/rowOf code nests the row. The item carries `helperSession: id`.
- `visibleSessions()` hides `parentId` sessions from the top-level chat list.
- Step-in on a helper row calls `focusChat(helperId)`. It is a plain chat with its own feed, its own question card from its own pane, and a composer that sends to it directly. Back returns to the parent.
- The row has a Stop button, which asks for confirmation while the helper is working. Its tooltip shows `tmux attach -t cc-<id8>`.

### Lifecycle: no dead tmux sessions
- One function closes a helper: `closeHelper(id)`.
  1. `kill-session -t =cc-<id8>`.
  2. `git worktree remove <cwd>`, without `--force`. If the worktree has uncommitted changes, it is kept and flagged.
  3. `git branch -d` if the branch is merged into its base; otherwise the branch is kept.
  4. Set `closedAt` and save.
- Triggers:
  - The main chat runs `stop`, after merging the helper's branch or after a final report that needs no follow-up.
  - The user clicks Stop.
  - The reaper closes it.
- Reaper (`reapHelpers()`) runs at server start and every 60 s. It only touches registered helpers, never other `cc-*` chats.
  - tmux gone (claude exited): finish steps 2–4.
  - Parent gone for more than 10 min and the helper not working: close.
  - Idle for more than 30 min, not asking and not waiting on the user: close.
  - Waiting on the user for more than 24 h: close.
- Kept after a close:
  - The transcript. Homebase never deletes it.
  - The registry entry.
  - The branch, unless it was merged.
- A closed row stays under the parent, read-only. The composer says "Closed — ask the main chat to start a new helper on branch X".
- Manual view: `homebase helper list --all`, plus the board rows. Fallback: `tmux ls`, `git worktree list`.

### Deleted
- The relay prompt and hint in web/src/composables/useComposer.ts.
- `relayed()` and its branch of `stepIn` in useStepIn.ts.
- `askingAgent`/`helperAsking` and `agentFeed` stay for in-process lookups only. Those lookups are read-only, and their composer is disabled.
- `sentSummaries` is removed once no work helpers use SendMessage.

### Migration
In-process subagents stay for read-only lookups and research (Explore, Haiku). Everything that changes code, or that the user may want to talk to, becomes a tmux helper.

### Rules updates
- homebase-rules.local.md and homebase-rules.md, orchestration section:
  - start work with `homebase helper start --title "<verb object>" --wait` in the background;
  - continue a helper with `homebase helper send`;
  - re-arm `wait` after a notice that isn't a final report;
  - run `list` after a restart;
  - `stop` a helper after merging its branch;
  - use the Agent tool only for read-only lookups.

### Cost and risks
- Each helper loads the full system prompt, about 15–25k tokens, cached once. Waiting costs nothing, since it is a background Bash command.
- Risks:
  - Parsing undocumented panes.
  - A trust dialog on the new worktree.
  - Concurrent starts (limits plus `withLock`).
  - A lost waiter after a restart (rule plus `list`).
  - Worktree disk use (the reaper).

## Phases (each a commit, each usable alone)
1. **Start, read, list, stop.** helpers.mjs (registry, `startHelper`, `closeHelper`), HELPER_RULE in claudeLine and claudeCmd, the token file, `/api/helpers` routes, `bin/homebase.mjs`.
2. **Send and wait.** Multi-send through `send()`, and the `wait` poll.
3. **Board nesting and step-in.** `parentId`, the synthetic agent row, hiding helpers from the top-level list, Back to the parent, the Stop button.
4. **Reaper.** At start and every 60 s; the closed state with a read-only view. `reapDecisions(helpers, sessions, live, now)` is pure and unit-tested.
5. **Rules.** The orchestration section, local and tracked.
6. **Delete the relay.** The useComposer relay, `relayed` in useStepIn, and the lookup composer. Update server/README.md and the README.

## Key Decisions
- Each helper is its own `claude` in its own `cc-<id8>` tmux, started the way reviewer.mjs starts a reviewer.
- Homebase creates the worktree (`helper/<slug>`, based on the parent's HEAD).
- Sonnet by default; the row title comes from `-n`.
- The parent is found from `$TMUX_PANE`, not from an argument.
- The finish notice is a background `homebase helper wait`. Homebase never types into the main chat.
- Sends reuse `send()` and reads reuse `summarize()`.
- Helper rows are synthetic agents on the parent.
- Cleanup goes through one `closeHelper()`. The reaper touches registered helpers only, the worktree is removed without `--force`, the branch is deleted only when merged, and the transcript is always kept.
- In-process subagents stay for read-only lookups.
- Closed helpers are read-only, not resumable.
- The tracked homebase-rules.md gets the Helpers section too.

Considered but skipped:
- Homebase typing a notice into the main chat. It would show as the user's message, and it is refused while a question is open.
- A Stop hook in the helper. It duplicates transcript polling.
- The main chat polling `read` in a loop. That keeps it busy and spends tokens.
- `claude -w`. Its base and branch naming are undocumented.
- Typing `/exit` to close a helper. `kill-session` already works and keeps the transcript.
- Reaping unregistered `cc-*` sessions. They may be the user's own chats.
- Resuming a closed helper. Deferred.
