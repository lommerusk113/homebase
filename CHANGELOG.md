# Changelog

Notable changes to Homebase, newest first.

## 0.1.0 - 2026-11-21

The first numbered state.

* A board of your Claude Code chats per project, with status, subagents, PR/MR state and work items.
* Chats driven through tmux: send, answer questions and permission prompts, interrupt, `/clear`, `/compact`, restart, pick a model.
* New project from GitHub or an existing folder, a changes view, and use from a phone through Tailscale with device pairing and push notifications.
* `--doctor`, `--setup` and `--demo`.
* Checked with Claude Code 2.1.330; a newer installed version shows a warning in the header and in `--doctor`.
* A `/model <alias>` sent from a chat backs up `~/.claude/settings.json` before restoring the default model.
* The session list is built once for all pages polling at the same time.
* On a phone: board actions ask before sending, a send button (Enter adds a line), a one-row header that stays on screen above the keyboard, menus and tables that fit the screen, 44px tap targets, and no "Pair a device…" on a paired device.
* In the chat, a button's message ("Load new rules", a row action, an issue's Start), slash-command and `!` output, and a "Ran: …" line each show as one line that opens to the full text; commands in a row fold into one.
* Issues and forge: an issue a chat already works on offers "Check on it" instead of a second Start, a forge that cannot be reached says so on the board in plain words (old data kept and dated), GitHub issues link to their PRs and say PR/GitHub, a conflicting PR is blocked, a project without milestones shows the issues assigned to you, and an MR closed without merging has its own group.
* Accessibility: Enter on a waiting row never lands on an answer, the phone layout with pane tabs up to 900px (a zoomed desktop), new replies announced to screen readers, a modal changes view, 12px smallest text and 4.5:1 status colours, names for the unnamed controls, and a switch for single-character shortcuts in the `?` overlay.
