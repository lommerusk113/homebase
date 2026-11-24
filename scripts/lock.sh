# Sourced by ship.sh and land.sh: one lock in the git dir so a ship or land waits for the one running. A dead holder's lock is taken over.
# HOMEBASE_LOCKED=1 means a parent script (land) already holds it.
take_lock() {
    [ -n "${HOMEBASE_LOCKED:-}" ] && return 0
    lock="$(git rev-parse --git-common-dir)/homebase-ship.lock"
    local shown=
    until mkdir "$lock" 2>/dev/null; do
        local pid; pid=$(cat "$lock/pid" 2>/dev/null)
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
        [ -n "$shown" ] || { echo "waiting for another ship/land (pid ${pid:-?})..."; shown=1; }
        sleep 2
    done
    echo $$ > "$lock/pid"
    trap 'rm -rf "$lock"' EXIT
    export HOMEBASE_LOCKED=1
}
