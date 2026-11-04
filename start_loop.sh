#!/bin/bash
# 罗宾猫雷达 引擎（Mac／Linux）：跟 Windows 的 start_loop.bat 一样——当掉自动重开（一键更新失败不自动还原，雷达会提醒）
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p data
while true; do
  [ -f WATCH_STOP ] && exit 0
  node watch.mjs >> data/watch_console.log 2>&1
  RC=$?
  [ "$RC" = "9" ] && exit 0
  [ -f WATCH_STOP ] && exit 0
  sleep 5
done
