#!/bin/sh
# Type-checks public/*.js against public/types.d.ts; no build, nothing emitted.
cd "$(dirname "$0")" && exec npx -y -p typescript@5.6.3 tsc -p jsconfig.json --noEmit
