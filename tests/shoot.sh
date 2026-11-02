#!/bin/sh
# usage: tests/shoot.sh <name> '<js setting window.__ globals>' [body=tests/visual-plants.js]
# writes tests/shot-<name>.png and tests/out-shot-<name>.json
body=${3:-tests/visual-plants.js}
tmp=tests/.shot-$1.js
printf '%s\n' "$2" > "$tmp"; cat "$body" >> "$tmp"
node scripts/launch.cjs --eval="$tmp" --out="tests/out-shot-$1.json" --shot="tests/shot-$1.png" > /dev/null
rm -f "$tmp"
