# Contributing to Homebase

Homebase is a hobby project.
Small, focused changes are welcome.

## Run the checks

All four must pass before a change goes in:

```sh
node test.mjs                  # unit tests; needs tmux on the PATH (one test types into a private tmux server)
./check-types.sh               # type-checks public/*.js; fetches TypeScript through npx, so it needs the network
(cd web && npm ci && npm run build)  # the Vue islands and their type check (web/README.md); before the browser tests, so they cover them
node tests/browser/run.mjs     # headless browser tests, several minutes; needs a local Chrome
```

`node test.mjs` runs the files in `tests/unit/` (one per area, shared fixtures in `helpers.mjs`) in the order its list gives; add a test to its area's file, and a new file to that list.
One line reading "items.json is corrupt" in the unit test output is expected.
The checks never touch your Claude sessions, your tmux sessions, your `~/.claude/settings.json` or a running Homebase; keep it that way in new tests (`HOMEBASE_CLAUDE_SETTINGS` points the settings code at a temp file).
The README's "Checks" section has the details.

There is no CI yet: the unit tests need `tmux` and the browser tests need Chrome, and they have only been run on macOS.

## No dependencies

Homebase runs on Node 20 or newer with nothing installed: no `npm install` and no runtime packages.
The one build is `web/` (Vue, with Vite as a dev dependency); its output is served when it exists.
Use what Node and the browser have.
A change that adds a runtime package, or a build step outside `web/`, will not be merged.

## Commits

One line per commit, no body, describing what changed:

```
## - <message>
```

One commit per logical change.
When behaviour described in the README changes, update the README in the same commit, and add a line to `CHANGELOG.md` for anything a user would notice.

## After a Claude Code update

Homebase reads Claude Code's screen and transcripts, which can change with any release (README, "Why tmux, not the Agent SDK").
When you have run the checks and driven a real chat (send, answer a question, a permission prompt, `/model`, `/compact`) on a newer Claude Code, set `VERIFIED_CLAUDE` in `server/setup.mjs` to that version.
Screens used as test fixtures go in `tests/fixtures/`, captured from a real Claude Code with `tmux capture-pane -p`.

## Landing and the `homebase` command

- `npm run land <branch> [--no-browser] [--dry-run]` lands a helper branch: fast-forward `main`, `scripts/ship.sh`, then remove the branch's worktree and branch (or `homebase helper stop <id>` for a registered helper).
  It refuses unless the main checkout is on a clean `main`, and with "needs a rebase onto main" when the branch is not a fast-forward; rebase it yourself.
  On a failing ship, `main` stays at the new tip and the output is printed.
  `land` and `ship` share one lock in `.git`, so two of them queue.
- Every Claude Homebase starts has `bin/` first on its PATH (`BIN_DIR` in `server/tmux.mjs`), so `homebase` works in each chat; `bin/homebase` is a symlink to `homebase.mjs`.
