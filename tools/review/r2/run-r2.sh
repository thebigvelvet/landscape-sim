#!/bin/bash
# Runs the round-2 review probes on each build. Usage: bash run-r2.sh <outdir> name=path/to/build ...
OUT=$1; shift; H=$(dirname "$0")/..; unset ELECTRON_RUN_AS_NODE
for pair in "$@"; do n=${pair%%=*}; B=${pair#*=}; EXE="$B/node_modules/electron/dist/electron.exe"
  for p in metrics shot-plants shot-fire shot-storm; do
    shot=""; [ "$p" != metrics ] && shot="--shot=$p.png"
    "$EXE" "$(cygpath -w $H)" --name=$n --dist="$(cygpath -w $B/dist)" --out="$(cygpath -w $OUT/$n)" --eval="$(cygpath -w $(dirname $0)/$p.js)" $shot 2>&1 | grep "^\[" | cut -c1-400
    [ -f "$OUT/$n/eval.json" ] && cp "$OUT/$n/eval.json" "$OUT/$n/$p.json"
  done
done
