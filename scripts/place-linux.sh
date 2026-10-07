#!/usr/bin/env bash
# Real mouse Toolbox gestures under Xvfb (xdotool), with screenshots while hovering and after:
#   xvfb-run -a -s "-screen 0 1600x1000x24" bash scripts/place-linux.sh <out-dir> <mode> <itemX> <itemY> <toX> <toY>
# mode = drag : drag the item from the palette docked in the designer and drop it on the surface;
#        place: click the item (side bar Toolbox or palette) to arm it, then click the surface.
set -euo pipefail
out=$1; mode=$2; fx=$3; fy=$4; tx=$5; ty=$6
mkdir -p "$out"
start=$(date +%s)
KUBUNO_DEMO=25 KUBUNO_DEMO_FILE=waffle node out/test/runTest.js >"$out/run-$mode.log" 2>&1 &
pid=$!
for _ in $(seq 1 600); do
  marker=$(ls -t /tmp/kubuno-vscode-ws-*/demo-ready 2>/dev/null | head -1 || true)
  if [ -n "$marker" ] && [ "$(stat -c %Y "$marker")" -ge "$start" ]; then break; fi
  sleep 0.5
done
sleep 4
import -window root "$out/linux-$mode-before.png"
xdotool mousemove "$fx" "$fy"
if [ "$mode" = drag ]; then
  sleep 0.3; xdotool mousedown 1; sleep 0.2
else
  xdotool click 1; sleep 1
fi
for k in $(seq 1 20); do
  xdotool mousemove $(( fx + (tx - fx) * k / 20 )) $(( fy + (ty - fy) * k / 20 )); sleep 0.05
done
sleep 0.7
import -window root "$out/linux-$mode-hover.png"
if [ "$mode" = drag ]; then xdotool mouseup 1; else xdotool click 1; fi
sleep 2
import -window root "$out/linux-$mode-after.png"
echo "captured $out/linux-$mode-*.png"
wait $pid
