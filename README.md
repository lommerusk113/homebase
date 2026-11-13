# Homebase

A local dashboard over your Claude Code sessions.

```sh
node server.mjs          # http://localhost:4321 (set PORT to change)
node test.mjs
./check-types.sh         # type-checks public/*.js (JSDoc + public/types.d.ts), no build
```

Run `./check-types.sh` before merging.

## Security

Homebase can type into Claude Code sessions, which run shell commands, so it only answers its own page:

- It listens on 127.0.0.1 only, unless LAN mode is on. Other machines can't reach it.
- Every request must carry `Host: localhost:<port>` (or `127.0.0.1`, `[::1]`); a request with a foreign `Origin` is refused. This blocks DNS rebinding and other websites.
- Every `/api/*` call needs the `x-homebase-token` header. The token is random per server start and is handed out inside the served page, which cross-origin pages can't read. After a restart the page reloads itself once to pick up the new token.

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
