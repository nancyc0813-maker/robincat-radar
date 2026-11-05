#!/bin/bash
# 打开罗宾猫雷达视窗（Mac）
cd "$(dirname "$(readlink "$0" || echo "$0")")" 2>/dev/null || cd "$(dirname "$0")"
[ -d radar ] || cd "$(dirname "$0")"
cd radar || exit 1
# V104-ELEC：桌面视窗元件（Electron）没装好就说清楚怎么修，不要默默没反应
if [ ! -x ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron ]; then
  MSG="罗宾猫雷达的桌面视窗元件（Electron）没有装好，所以打不开视窗（常见原因：连不上 GitHub，下载失败）。引擎不受影响，照常在背景运行。

修好的方法（二选一）：
1. 网络正常后（或开 VPN），再执行一次「一键安装-Mac.command」
2. 手动：打开「终端机」，依序输入：
cd \"$(pwd)\"
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci --registry=https://registry.npmmirror.com"
  echo "$MSG"
  osascript -e 'on run argv' -e 'display dialog (item 1 of argv) buttons {"知道了"} default button 1 with title "罗宾猫雷达" with icon caution' -e 'end run' "$MSG" >/dev/null 2>&1
  exit 1
fi
nohup ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . >/dev/null 2>&1 &
sleep 1
osascript -e 'tell application "Terminal" to close (every window whose name contains "罗宾猫雷达")' >/dev/null 2>&1 &
exit 0
