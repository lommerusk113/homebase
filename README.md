# Homebase

A local dashboard over your Claude Code sessions.

## Requirements

* macOS (the keychain and `/usr/bin` tools are macOS ones), Node.js.
* `tmux`, and the `claude` CLI on the PATH of your login shell (`$SHELL -lic`).
* Optional: `gh` and `glab`, signed in, for GitHub PRs and GitLab MRs.

```sh
node server.mjs          # http://localhost:4321 (set PORT to change)
```

The rate limits in the header come from `scripts/statusline.sh`: set it as Claude Code's `statusLine` command.

Homebase remembers the MRs/PRs it has seen in `~/.claude/homebase/items.json` (`HOMEBASE_DIR` moves it), so the Work tab doesn't lose one when its link scrolls out of a transcript; deleting the file is safe.

Images attached in the chat (paste, drop or the paperclip) are stored in `~/.claude/homebase/uploads/` (`HOMEBASE_DIR` moves it) and sent as `[Image: <path>]` lines, which Claude opens with its Read tool; the folder is never cleaned up, so delete old files when you like.

Push notifications: "Enable notifications on this device" in the chat's ⋯ menu makes the server send a Web Push when a chat starts asking or needs you, at most one per chat per 30s, and none while a Homebase page was focused in the last minute.
They arrive with the page closed. On an iPhone (iOS 16.4+), open Homebase over HTTPS, add it to the Home Screen, open it from there and enable it in the menu.
The VAPID keys and subscriptions live in `~/.claude/homebase/vapid.json` and `subscriptions.json` (`HOMEBASE_DIR` moves them); this computer's browser and paired devices may subscribe.

## Asking hook

A chat waiting on you (an AskUserQuestion or a tool permission prompt) shows as "<chat> is asking" at the top of Needs you in the Work tab; click it to answer in the chat, where each option of the question on its tmux pane is a button.
Claude Code writes an AskUserQuestion to the transcript only once it is answered when the same message also started background agents, so Homebase also reads a marker that `hooks/asking.mjs` keeps in `~/.claude/homebase/asking/<session>.json` (`HOMEBASE_DIR` moves it).

Every Claude that Homebase starts or resumes gets `homebase-rules.md` appended to its system prompt (`--append-system-prompt-file`): how replies, subagents and questions fit Homebase. Edit it to change how all Homebase chats behave; chats already running pick it up when restarted.
Install it in `~/.claude/settings.json`, with `<homebase-dir>` as the absolute path of this checkout (merge into any `hooks` you already have):

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "node <homebase-dir>/hooks/asking.mjs" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "node <homebase-dir>/hooks/asking.mjs", "async": true }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node <homebase-dir>/hooks/asking.mjs" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node <homebase-dir>/hooks/asking.mjs" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node <homebase-dir>/hooks/asking.mjs" }] }]
  }
}
```

The answer, the next tool (for a permission prompt), a new prompt or the end of the turn removes the marker; Homebase also ignores one the transcript has moved past, or one older than a day.
The hook never blocks or changes anything in Claude Code and prints nothing. Without it, only questions already in the transcript show.

## New project

The ☰ dialog's "New project…" button asks for a name, creates a GitHub repo for your account, clones it, starts a Claude chat in tmux (`cc-new-<name>`) and adds the project to your board.
It runs `gh` as you are signed in (`gh auth login`); to use a separate token instead, put it in the macOS keychain (`security add-generic-password -s <service> -a "$USER" -w`, a fine-grained token that may create repositories) and name the item as `keychainService` below.
A keychain token is read when you press Create, kept in memory, handed only to `gh` as `GH_TOKEN` (with `GITHUB_TOKEN` removed), and scrubbed from any error shown.
Claude Code's workspace trust dialog for the new folder is answered "Yes" for you, but only when the dialog names exactly the folder Homebase just cloned; nothing else is ever auto-answered.
Any other blocking startup dialog in a `cc-*` tmux session shows in the chat with its options as buttons (and the `tmux attach` hint); clicking one selects it in the terminal, and the message box refuses to send while it is up.
If creating the repo fails nothing else happens; if cloning or starting the chat fails, the error says what already exists.

To chat in a project that is already on disk, use "Open existing folder…" in the ☰ dialog (or "Open" on an already cloned repo under "From my GitHub").
It lists the git repos directly under `baseDir`, most recently used first, leaving out any that already have a running Claude or tmux session, and starts a Claude chat there the same way (`POST /api/projects/open` with `{ "dir": ... }`).
The server only starts it in an existing folder whose real path (symlinks and `..` resolved) is inside `baseDir`, or is the folder of a session it already shows; the trust dialog is answered for that folder too.

The defaults can be overridden in `~/.claude/homebase/config.json` (`HOMEBASE_DIR` moves it). The file is optional, lives outside the repo and Homebase never writes it:

```json
{ "newProject": { "owner": "my-github-login", "keychainService": "gh-personal", "sshHost": "github-personal", "baseDir": "~/code", "private": true } }
```

* `owner`: the GitHub account the repo is created under (default: the login from `gh api user`).
* `keychainService`: the keychain item that holds a token for it (default: none, `gh` uses its own login). Repos of `owner`, or cloned via `sshHost`, then use that token for every `gh` call; all other repos use your normal `gh` login.
* `sshHost`: the SSH host alias used to clone (`git@<sshHost>:<owner>/<name>.git`; default `github.com`).
* `baseDir`: where the clone goes, and where "Open existing folder…" looks (`~` is expanded; default `~/Projects`).
* `private`: the default of the "Private" switch.

Only the keys you give are overridden.

## Checks

Every merge must pass these:

```sh
node test.mjs                  # unit tests
node tests/browser/run.mjs     # headless browser tests (about 30 s)
./check-types.sh               # type-checks public/*.js, no build
```

The browser tests need only Node and a local Chrome (set `CHROME=/path/to/chrome` if it isn't in the usual place).
They start their own server on a free port over a throwaway HOME with fixture transcripts, and put stub `glab`/`gh` executables first on PATH, so they never touch your sessions, tmux, GitLab, GitHub or a running Homebase.
POSTs from the page are answered by the test, so nothing is ever typed into a session.
Pass words to run only the matching tests, e.g. `node tests/browser/run.mjs chat`.
By default only failing tests and the summary line are printed; the full log is written to `tests/browser/last-run.log` (gitignored) and `-v` prints it all.
Runs are serialised across processes and worktrees by a lock file in the system temp dir (`homebase-browser-suite.lock`, holding the pid); a second run prints "waiting for another suite run…" until the first is done, and a lock left by a dead process is ignored.
The fixtures are in `tests/browser/fixture.mjs` (transcripts) and `tests/browser/forge-stub.mjs` (canned GitLab/GitHub answers); a forge call the stub doesn't know is listed after the run.

## Security

Homebase can type into Claude Code sessions, which run shell commands, so it only answers its own page:

- It listens on 127.0.0.1 only. Other machines can't reach it, except through `tailscale serve` on the remote port (below), where every device must be paired.
- Every request must carry `Host: localhost:<port>` (or `127.0.0.1`, `[::1]`), or on the remote port exactly `remote.host`; a request with a foreign `Origin` is refused. This blocks DNS rebinding and other websites.
- Every `/api/*` call needs the `x-homebase-token` header. The token is random per server start and is handed out inside the served page, which cross-origin pages can't read. After a restart the page fetches the new token on its next API call, without reloading.

The token stops other websites, not local programs.
Any process on the Mac, run by any OS user, can fetch the page, read the token and call the API.
That's fine on a single-user Mac, where such a process can already read `~/.claude` and type into tmux.
Don't run Homebase on a Mac shared with other users.

The old `HOMEBASE_LAN=1` mode, which handed the token to any device on the network, is gone; the server refuses to start with it set.

## Use from your phone (Tailscale)

[Tailscale](https://tailscale.com) is a private WireGuard network between your own devices; `tailscale serve` gives the Mac an HTTPS address with a real certificate that only devices on your tailnet can reach.

1. Install Tailscale on the Mac and the phone and sign both in to the same account. Turn on MagicDNS and HTTPS certificates in the admin console (DNS page).
2. Tell Homebase the Mac's tailnet name in `~/.claude/homebase/config.json` and restart it:

   ```json
   { "remote": { "host": "mymac.tail1234.ts.net", "login": "me@example.com" } }
   ```

   * `host`: the Mac's full MagicDNS name, as the admin console's Machines page shows it. Exactly this name is allowed, no wildcard.
   * `port`: the second loopback port Homebase opens for remote requests (default `PORT + 1`, 4322).
   * `login` (optional): your Tailscale login; requests whose `Tailscale-User-Login` header differs are refused.
3. Expose that port on the tailnet:

   ```sh
   tailscale serve --bg http://127.0.0.1:4322
   ```

   (`tailscale serve status` shows it; `tailscale serve --https=443 http://127.0.0.1:4322 off` stops it.)
4. On the phone open `https://mymac.tail1234.ts.net`. It shows "Pair this device".
   On the Mac, open Homebase, ☰ → Pair a device…, and type the 6-digit code it shows on the phone.

How it stays safe:

* Homebase still listens on 127.0.0.1 only. Everything arriving on the remote port counts as remote, whatever its `Host` header says (`tailscale serve` routes by TLS name and passes the `Host` through, so a tailnet peer could otherwise claim to be `localhost`).
* A remote device without a valid device cookie gets only the pair page; no token, no app files, no API.
* A code is valid for 5 minutes and works once; a new code replaces the old one. After 5 wrong codes in a minute, all tries are refused until the minute is over.
* Pairing sets a random 256-bit cookie (HttpOnly, Secure, SameSite=Strict, kept 400 days). Homebase stores only its SHA-256 in `~/.claude/homebase/devices.json`, with the device name and when it was last seen.
* ☰ → Pair a device… also lists the paired devices; Revoke logs one out at once. Pairing is managed from the Mac only.
* `Tailscale-User-Login` is set by `tailscale serve` itself, which drops any value the client sent; it is trusted only on the remote port, which only `serve` reaches.
* A paired device gets the same per-start token as the Mac, so the Host, Origin and token checks above all apply too.

Until Claude writes its first transcript (on the first prompt) the chat sends to `cc-new-<name>` by tmux name (`/api/send?tmux=`, only that name pattern and only while the session runs), and `/api/starting` lets a reloaded page find it again.
The chat menu's "Restart chat" (`POST /api/restart?id=`) kills the chat's Homebase tmux session and resumes it so Claude reloads (e.g. an edited `homebase-rules.md`); refused while Claude is working or asking, or when the chat doesn't run in Homebase's tmux.
Once the transcript exists, Homebase maps it to that tmux session on every poll (same start folder, no tmux of its own), so no second Claude is started.
