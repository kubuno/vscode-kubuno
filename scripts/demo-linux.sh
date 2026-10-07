#!/usr/bin/env bash
# Screenshots of the designer, the Toolbox and Properties on Linux, under Xvfb (no desktop session needed):
#   xvfb-run -a -s "-screen 0 1600x1000x24" bash scripts/demo-linux.sh <out-dir> [waffle|drive]
# Runs the integration tests with the demo layout kept open, then captures the whole X screen.
set -euo pipefail
out=${1:-captures}
which=${2:-waffle}
mkdir -p "$out"
start=$(date +%s)
KUBUNO_DEMO=20 KUBUNO_DEMO_FILE=$which node out/test/runTest.js >"$out/run-$which.log" 2>&1 &
pid=$!
for _ in $(seq 1 600); do
  marker=$(ls -t /tmp/kubuno-vscode-ws-*/demo-ready 2>/dev/null | head -1 || true)
  if [ -n "$marker" ] && [ "$(stat -c %Y "$marker")" -ge "$start" ]; then break; fi
  sleep 0.5
done
sleep 4
import -window root "$out/linux-$which.png"
echo "captured $out/linux-$which.png"
wait $pid
