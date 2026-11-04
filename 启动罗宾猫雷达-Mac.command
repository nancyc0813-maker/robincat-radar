#!/bin/bash
# 打开罗宾猫雷达视窗（Mac）
cd "$(dirname "$(readlink "$0" || echo "$0")")" 2>/dev/null || cd "$(dirname "$0")"
[ -d radar ] || cd "$(dirname "$0")"
cd radar || exit 1
nohup ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . >/dev/null 2>&1 &
sleep 1
osascript -e 'tell application "Terminal" to close (every window whose name contains "罗宾猫雷达")' >/dev/null 2>&1 &
exit 0
