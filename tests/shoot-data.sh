#!/bin/sh
# usage: tests/shoot-data.sh <name> '<js setting window.__ globals>' <body.js>
# Runs the body in the app; the body returns { png: <data URL>, ... }. Writes tests/shot-<name>.png
# and tests/out-shot-<name>.json (without the picture). Avoids capturePage, which can hang.
tmp=tests/.shot-$1.js
printf '%s\n' "$2" > "$tmp"; cat "$3" >> "$tmp"
node scripts/launch.cjs --eval="$tmp" --out="tests/out-shot-$1.json" > /dev/null
rm -f "$tmp"
node -e "
const fs = require('fs'), f = 'tests/out-shot-$1.json', o = JSON.parse(fs.readFileSync(f, 'utf8'));
if (o.png) { fs.writeFileSync('tests/shot-$1.png', Buffer.from(o.png.split(',')[1], 'base64')); delete o.png; }
fs.writeFileSync(f, JSON.stringify(o, null, 2));
"
