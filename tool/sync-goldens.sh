#!/usr/bin/env bash
# Copies the parity fixtures + goldens from the verification harness
# (github.com/lgka-app/verification, expected as a sibling checkout named
# lgka-verification) into test/. Never edit test/fixtures or test/goldens by hand.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:-$here/../lgka-verification}"
[ -d "$src/goldens" ] || { echo "verification harness not found at $src" >&2; exit 1; }
rm -rf "$here/test/fixtures" "$here/test/goldens"
cp -R "$src/fixtures" "$here/test/fixtures"
cp -R "$src/goldens" "$here/test/goldens"
find "$here/test/goldens" -name '*.layout.txt' -delete
echo "synced from $src ($(find "$here/test/fixtures" -type f | wc -l | tr -d ' ') fixtures, $(find "$here/test/goldens" -type f | wc -l | tr -d ' ') goldens)"
