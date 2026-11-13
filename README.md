# Homebase

A local dashboard over your Claude Code sessions.

```sh
node server.mjs          # http://localhost:4321 (set PORT to change)
```

The rate limits in the header come from `scripts/statusline.sh`: set it as Claude Code's `statusLine` command.

## A second GitHub account

`gh` runs with your usual login (`GITHUB_TOKEN` or `gh auth`).
A repo whose origin uses the SSH host alias `github-personal` (e.g. `git@github-personal:me/repo.git`) runs `gh` with the token in the keychain service `gh-personal` instead, passed as `GH_TOKEN`.
Store it once:

```sh
security add-generic-password -a "$USER" -s gh-personal -w   # prompts for the token
```

Use a fine-grained token for that account with: Issues read/write, Pull requests read/write, Contents read, Metadata read, Commit statuses read, Checks read, and Actions read for CI.
Other aliases: `HOMEBASE_GH_TOKENS="github-personal=gh-personal,github-other=gh-other"` (alias=keychain service).
The token is read on first use; if it's missing, Homebase logs that once and uses the default account.

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
