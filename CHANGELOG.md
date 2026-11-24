# Changelog

Notable changes to Homebase, newest first.

## Unreleased


* Loading new rules after a reply that asks you something no longer drops it from "needs you" (board, filter, notifications).
* `homebase-rules.local.md` is now appended after `homebase-rules.md` instead of replacing it; both are watched for "Load new rules".

## 0.1.0 - 2026-11-21

The first numbered state.

* A board of your Claude Code chats per project, with status, subagents, PR/MR state and work items.
* Chats driven through tmux: send, answer questions and permission prompts, interrupt, `/clear`, `/compact`, restart, pick a model.
* New project from GitHub or an existing folder, a changes view, and use from a phone through Tailscale with device pairing and push notifications.
* `--doctor`, `--setup` and `--demo`.
* Checked with Claude Code 2.1.331; a newer installed version shows a warning in the header and in `--doctor`.
* A `/model <alias>` sent from a chat backs up `~/.claude/settings.json` before restoring the default model.
* The session list is built once for all pages polling at the same time.
* On a phone: board actions ask before sending, a send button (Enter adds a line), a one-row header that stays on screen above the keyboard, menus and tables that fit the screen, 44px tap targets, and no "Pair a device…" on a paired device.
* In the chat, a button's message ("Load new rules", a row action, an issue's Start), slash-command and `!` output, and a "Ran: …" line each show as one line that opens to the full text; commands in a row fold into one.
* Issues and forge: an issue a chat already works on offers "Check on it" instead of a second Start, a forge that cannot be reached says so on the board in plain words (old data kept and dated), GitHub issues link to their PRs and say PR/GitHub, a conflicting PR is blocked, a project without milestones shows the issues assigned to you, and an MR closed without merging has its own group.
* Accessibility: Enter on a waiting row never lands on an answer, the phone layout with pane tabs up to 900px (a zoomed desktop), new replies announced to screen readers, a modal changes view, 12px smallest text and 4.5:1 status colours, names for the unnamed controls, and a switch for single-character shortcuts in the `?` overlay.
* When things go wrong: one odd transcript entry or unreadable chat no longer fails the whole board (it is skipped and logged once), a missing `~/.claude/projects` folder is an empty first run, and a corrupt `config.json`, `handled.json` or `tracked.json` is set aside as `.bak` with a log line (`--doctor` reports the config). The page says "Server error" for a failing Homebase and "Offline" only when it can't be reached.
* A chat whose turn went silent for 30 minutes without ending keeps a Needs you row until you open it (only turns that died after this first ran; never a chat you closed, and no push), and a chat still waiting on your answer stays on the board for up to 14 days.
* A send Homebase did not answer in time is "Not confirmed" rather than "Not sent", and Retry checks the transcript first so nothing is sent twice; the draft is dropped when the send starts.
* A reply that can't be rendered shows as plain text instead of blanking the chat; a huge table or code block shows its first part with "Show all"; "Show earlier" says when older messages are only in the terminal; right-to-left titles no longer tear row labels; ages follow the server's clock.
