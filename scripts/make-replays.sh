#!/bin/sh
# Writes the sample replays used by the viewer (viewer/public/replays/). Run after `npm run build`.
set -e
OUT=viewer/public/replays
mkdir -p "$OUT"
for c in flat-coast mountain-pass; do
  node dist/src/replay-cli.js --course samples/courses/$c.json --roster samples/roster.csv \
    --plans samples/plans/$c --params samples/params/params-v2.csv --out "$OUT/$c.json.gz"
done
cat > "$OUT/index.json" <<'JSON'
[
  { "file": "flat-coast.json.gz", "title": "平地: 海岸線ステージ（サンプル作戦・params v2）" },
  { "file": "mountain-pass.json.gz", "title": "山岳: 峠越え山頂ゴール（サンプル作戦・params v2）" }
]
JSON
