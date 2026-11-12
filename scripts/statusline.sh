#!/bin/sh
# Claude Code statusLine command: saves the status JSON for Homebase (rate limits) and prints "5h 34% · 7d 12% · ctx 41%".
# Writes ~/.claude/homebase/statusline/<session_id>.json atomically (temp file + rename).
dir="$HOME/.claude/homebase/statusline"
mkdir -p "$dir" || exit 0
exec node -e '
const fs = require("fs");
const dir = process.argv[1];
let raw = "";
process.stdin.on("data", c => { raw += c; }).on("end", () => {
    let j;
    try {
        j = JSON.parse(raw);
    } catch {
        return;
    }
    const id = String(j.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
    if (id) {
        const tmp = `${dir}/.${id}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, raw);
            fs.renameSync(tmp, `${dir}/${id}.json`);
        } catch {}
    }
    const pct = (label, v) => (typeof v === "number" ? `${label} ${Math.round(v)}%` : null);
    const r = j.rate_limits || {};
    console.log([pct("5h", r.five_hour?.used_percentage), pct("7d", r.seven_day?.used_percentage), pct("ctx", j.context_window?.used_percentage)].filter(Boolean).join(" · "));
});
' "$dir"
