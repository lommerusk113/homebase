# Homebase

A local dashboard over your Claude Code sessions.

```sh
node server.mjs          # http://localhost:4321 (set PORT to change)
```

The rate limits in the header come from `scripts/statusline.sh`: set it as Claude Code's `statusLine` command.

Homebase remembers the MRs/PRs it has seen in `~/.claude/homebase/items.json` (`HOMEBASE_DIR` moves it), so the Work tab doesn't lose one when its link scrolls out of a transcript; deleting the file is safe.

## New project

The ☰ dialog's "New project…" button asks for a name, creates a GitHub repo for your personal account, clones it, starts a Claude chat in tmux (`cc-new-<name>`) and adds the project to your board.
It needs a fine-grained token in the macOS keychain (`security add-generic-password -s gh-personal -a "$USER" -w`) that may create repositories.
The token is read when you press Create, kept in memory, handed only to `gh` as `GH_TOKEN` (with `GITHUB_TOKEN` removed), and scrubbed from any error shown.
If creating the repo fails nothing else happens; if cloning or starting the chat fails, the error says what already exists.

The defaults can be overridden in `~/.claude/homebase/config.json` (`HOMEBASE_DIR` moves it). The file is optional and Homebase never writes it:

```json
{ "newProject": { "owner": "lommerusk113", "keychainService": "gh-personal", "sshHost": "github-personal", "baseDir": "~/IdeaProjects/Privat", "private": true } }
```

* `owner`: the GitHub account the repo is created under.
* `keychainService`: the keychain item that holds the token.
* `sshHost`: the SSH host alias used to clone (`git@<sshHost>:<owner>/<name>.git`).
* `baseDir`: where the clone goes (`~` is expanded).
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
The fixtures are in `tests/browser/fixture.mjs` (transcripts) and `tests/browser/forge-stub.mjs` (canned GitLab/GitHub answers); a forge call the stub doesn't know is listed after the run.

## Security

Homebase can type into Claude Code sessions, which run shell commands, so it only answers its own page:

- It listens on 127.0.0.1 only, unless LAN mode is on. Other machines can't reach it.
- Every request must carry `Host: localhost:<port>` (or `127.0.0.1`, `[::1]`); a request with a foreign `Origin` is refused. This blocks DNS rebinding and other websites.
- Every `/api/*` call needs the `x-homebase-token` header. The token is random per server start and is handed out inside the served page, which cross-origin pages can't read. After a restart the page fetches the new token on its next API call, without reloading.

The token stops other websites, not local programs.
Any process on the Mac, run by any OS user, can fetch the page, read the token and call the API.
That's fine on a single-user Mac, where such a process can already read `~/.claude` and type into tmux.
Don't run Homebase on a Mac shared with other users.

LAN mode is plain HTTP, so anyone who can watch the network traffic can steal the pairing cookie.
Fine on a trusted home network; don't use it on shared or public Wi-Fi.

Known hardening gaps (not vulnerabilities):

- The pairing rate limiter's per-address map is never pruned.
- All paired devices share one session secret, so revoking one device means rotating it and re-pairing all of them.

## Access from another computer

```sh
HOMEBASE_LAN=1 node server.mjs
```

Open `http://<mac>.local:4321` (or the Mac's LAN IP) on the other computer and enter the pairing code printed in the terminal.
If the server runs under nohup, read the code with `cat ~/.claude/homebase/pairing-code`.
A new code is made at every start; 5 wrong tries in a minute lock that address out for 15 minutes.

Pairing sets a long-lived cookie, so the device stays paired across restarts.
To log out every paired device, delete `~/.claude/homebase/session-secret` and restart.

LAN mode is plain HTTP: anyone on your network who can watch your traffic can see the pages and steal the cookie.
Use it only on a network you trust.
