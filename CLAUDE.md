# Homebase

Dashboard that drives Claude Code chats through tmux. Hobby repo, Node >= 20, no runtime dependencies (only `web/` has a build).
Read first: `CONTRIBUTING.md` (checks, commits), `server/README.md` (module map), `web/README.md` (Vue port, rules), `README.md` (behaviour), `docs/internals.md`.

## Where things live

| Path | What |
|---|---|
| `server.mjs` | Entry point: env config, startup, router; re-exports what the unit tests use |
| `server/*.mjs` | Server modules, one per area (map in `server/README.md`) |
| `bin/homebase.mjs` | CLI used inside chats (`helper start/read/list/stop/send/wait`) |
| `hooks/` | Claude Code hooks (asking marker, checks) |
| `homebase-rules.md` | Rules Homebase adds to every chat it starts; the user's gitignored `homebase-rules.local.md` is appended after it, never edit |
| `public/*.js` | Legacy UI, loaded by the Vue code as `old/<file>.js`; shrinking, port out of it, don't grow it |
| `web/src/` | Vue 3 + TS port: `islands/` (one Vue app per section), `composables/` (state per concern), `components/` (shared bits), `lib/` (pure logic, erasable TS, also imported by `tests/unit` and `server/`), `keys.ts` (injection keys), `old.ts` (bridge to old state) |
| `web/dist` | Build output, gitignored; the server only injects it when it exists |
| `tests/unit/`, `tests/browser/` | One file per area; fixtures in `tests/fixtures/` |

Which layer to change: new or ported UI goes in `web/src`. Touch `public/*.js` only for what is not yet ported (keyboard in `public/keys.js`, shell/bootstrap/polling, phone tabs) or to hand off to a port. Server behaviour: `server/<area>.mjs`. API response types: `public/api.d.ts`.

## Commands

```sh
node test.mjs                                  # all unit tests (needs tmux)
node tests/unit/<name>.mjs                     # one area, e.g. chat; names in the UNITS list in test.mjs
(cd web && npm ci && npm run build)            # Vue build + vue-tsc; needed before browser tests
node tests/browser/run.mjs [-v] <filter>...    # substring of "<file>: <test>", e.g. islands or "chat: send"; needs Chrome
./check-types.sh                               # type check of public/*.js (npx, needs network)
(cd web && npm run check)                      # type check of web/src alone
```

Changed `web/src`? Rebuild before running browser tests. A new unit file goes into the `UNITS` list in `test.mjs`.

## Ship

`npm run ship` (`scripts/ship.sh`): only from a clean `main`; runs unit tests, types, browser suite (`--no-browser` skips), pushes `origin main`, reloads the running Homebase. Helpers never run it.

## Conventions

* One commit per logical change. Update README in the same commit when documented behaviour changes, and a `CHANGELOG.md` line for anything user-visible.
* No new dependencies, no build step outside `web/`.
* Vue (full list in `web/README.md`): provide/inject with typed `InjectionKey`s from `src/keys.ts` (`useInjected`), never props down or string keys; one composable per concern; components small (about 100 lines max, split by job); only composables read `oldState`; island `useId()` ids get a section prefix.
* Keep classes, ids and `data-` attributes the browser tests look for, or update the tests in the same commit.

## Hard don'ts

* Helpers never push, merge, run `npm run ship` or restart the user's Homebase on :4321; never `pkill node`.
* Never send input to real Claude sessions or tmux panes, and never start a real `claude`; tests use the fixtures, a private tmux server and `HOMEBASE_CLAUDE_SETTINGS` pointing at a temp file.
* Never run `git config`; never edit `homebase-rules.local.md` or anything in `~/.claude/`.
