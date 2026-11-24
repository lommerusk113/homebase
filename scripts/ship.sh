#!/usr/bin/env bash
# Land the current main on origin: checks, push, reload the running Homebase. `--no-browser` skips the browser suite, `--dry-run` skips the push and the reload.
set -uo pipefail
cd "$(dirname "$0")/.."
die() { echo "ship: $*" >&2; exit 1; }
. scripts/lock.sh
take_lock
no_browser=; dry=
for a in "$@"; do case $a in --no-browser) no_browser=1;; --dry-run) dry=1;; *) die "unknown option $a";; esac; done

[ "$(git branch --show-current)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "working tree not clean"

node test.mjs >/dev/null 2>&1 || die "unit tests failed (run: node test.mjs)"
./check-types.sh >/dev/null 2>&1 || die "type check failed (run: ./check-types.sh)"
echo "unit tests + types: exit 0"

if [ -z "$no_browser" ]; then
    log=$(node tests/browser/run.mjs 2>&1); code=$?
    if [ $code -ne 0 ]; then
        echo "$log" | grep -E '^FAIL'
        # a failing line reads "FAIL <file>: <test> (1.2s)"; rerun those files once
        filters=$(echo "$log" | sed -nE 's/^FAIL ([^:]+):.*/\1:/p' | sort -u)
        [ -n "$filters" ] || die "browser suite failed without a test FAIL line"
        # shellcheck disable=SC2086
        log=$(node tests/browser/run.mjs $filters 2>&1) || { echo "$log" | grep -E '^FAIL|passed'; die "browser tests still fail"; }
    fi
    echo "$log" | grep -E 'passed'
fi

[ -n "$dry" ] && { echo "dry run: push and reload skipped"; exit 0; }
git push origin HEAD:main || die "push failed"

PORT=${PORT:-4321}; URL=http://127.0.0.1:$PORT
page=$(curl -fs --max-time 3 "$URL/") || { echo "nothing listens on :$PORT, reload skipped"; exit 0; }
T=$(echo "$page" | sed -nE 's/.*name="homebase-token" content="([^"]*)".*/\1/p' | head -1)
curl -fs -X POST -H 'x-codetool: 1' -H "x-homebase-token: $T" "$URL/api/server/reload" >/dev/null && echo "reloaded Homebase on :$PORT" || echo "reload request failed"
