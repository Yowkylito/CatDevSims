#!/bin/sh
set -e
cd "$(dirname "$0")"
OUT="/tmp/steward-built"
mkdir -p "$OUT"
bun build tests/steward.test.ts --outfile "$OUT/steward.test.mjs" --target node --format esm
node --test "$OUT/steward.test.mjs"
