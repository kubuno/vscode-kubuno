#!/usr/bin/env bash
# Real mouse placement of a Toolbox item on the design surface under Xvfb (xdotool): a click on the Toolbox item
# arms it, a click on the surface places it. Screenshots before, while hovering and after:
#   xvfb-run -a -s "-screen 0 1600x1000x24" bash scripts/place-linux.sh <out-dir> <itemX> <itemY> <toX> <toY>
# (An HTML5 drag from the Toolbox view cannot reach the designer: VS Code blocks pointer events on every webview
# while something is dragged — `scripts/` history and docs/VSCODE.md §5.)
set -euo pipefail
out=$1; fx=$2; fy=$3; tx=$4; ty=$5
mkdir -p "$out"
start=$(date +%s)
KUBUNO_DEMO=25 KUBUNO_DEMO_FILE=waffle node out/test/runTest.js >"$out/run-place.log" 2>&1 &
pid=$!
for _ in $(seq 1 600); do
  marker=$(ls -t /tmp/kubuno-vscode-ws-*/demo-ready 2>/dev/null | head -1 || true)
  if [ -n "$marker" ] && [ "$(stat -c %Y "$marker")" -ge "$start" ]; then break; fi
  sleep 0.5
done
sleep 4
xdotool mousemove "$fx" "$fy" click 1
sleep 1
for k in $(seq 1 15); do
  xdotool mousemove $(( fx + (tx - fx) * k / 15 )) $(( fy + (ty - fy) * k / 15 )); sleep 0.05
done
sleep 0.7
import -window root "$out/linux-place-hover.png"
xdotool click 1
sleep 2
import -window root "$out/linux-place-after.png"
echo "captured $out/linux-place-*.png"
wait $pid
