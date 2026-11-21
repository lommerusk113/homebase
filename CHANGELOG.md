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
