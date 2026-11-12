# Homebase

A local dashboard over your Claude Code sessions.

```sh
node server.mjs          # http://localhost:4321 (set PORT to change)
node test.mjs
```

## Security

Homebase can type into Claude Code sessions, which run shell commands, so it only answers its own page:

- It listens on 127.0.0.1 only, unless LAN mode is on.
- Every request must carry `Host: localhost:<port>` (or `127.0.0.1`, `[::1]`); a request with a foreign `Origin` is refused. This blocks DNS rebinding and other websites.
- Every `/api/*` call needs the `x-homebase-token` header. The token is random per server start and is handed out only inside the served page, so other local programs can't call the API. After a restart the page reloads itself once to pick up the new token.

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
