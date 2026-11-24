#!/usr/bin/env bash
# Land a helper branch: fast-forward main to <branch>, run ship.sh, then remove the branch's worktree and branch (or stop the helper).
# `npm run land <branch> [--no-browser] [--dry-run]`; the options go to ship.sh. Lands queue on the lock ship.sh shares.
set -uo pipefail
die() { echo "land: $*" >&2; exit 1; }
branch=${1:-}; [ -n "$branch" ] && [ "${branch#-}" = "$branch" ] || die "usage: npm run land <branch> [--no-browser] [--dry-run]"
shift
main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
cd "$main" || die "no main checkout"
. scripts/lock.sh
take_lock

[ "$(git branch --show-current)" = main ] || die "the main checkout is not on main"
[ -z "$(git status --porcelain)" ] || die "main checkout not clean"
git rev-parse --verify -q "refs/heads/$branch" >/dev/null || die "no branch $branch"
git merge --ff-only "$branch" >/dev/null 2>&1 || die "$branch needs a rebase onto main"
echo "main is at $(git rev-parse --short HEAD) ($branch)"

# ponytail: on failure main stays at the new tip, as asked; fix on the branch, rebase, land again.
out=$(./scripts/ship.sh "$@" 2>&1) || { echo "$out"; die "ship failed, main stays at $(git rev-parse --short HEAD)"; }
echo "$out"

id=$(HB="${HOMEBASE_DIR:-$HOME/.claude/homebase}/helpers.json" B=$branch node -e '
  try { const h = JSON.parse(require("fs").readFileSync(process.env.HB, "utf8")).find(x => x.branch === process.env.B && !x.closedAt); if (h) console.log(h.id); } catch {}')
if [ -n "$id" ]; then
    "$main/bin/homebase.mjs" helper stop "$id" || echo "land: could not stop helper $id, stop it by hand"
else
    wt=$(git worktree list --porcelain | awk -v b="refs/heads/$branch" '/^worktree /{w=substr($0,10)} $0=="branch " b{print w}')
    [ -z "$wt" ] || [ "$wt" = "$main" ] || git worktree remove "$wt" || echo "land: worktree $wt not removed"
    git branch -d "$branch" || echo "land: branch $branch not deleted"
fi
