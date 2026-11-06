#!/bin/bash
# 罗宾猫雷达 一键安装（Mac 版）。在 Finder 里双击这个档就会执行。
# 第一次如果出现「无法打开，因为来自身份不明的开发者」：在这个档上按右键 → 打开 → 再按一次打开。
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# H2：带参数（--name1 … --addr1 …）或不是在真的终端机里跑（AI 帮忙执行）→ 不停下来等 Enter
NI=""; if [ $# -gt 0 ] || [ ! -t 0 ] || [ -n "$RC_NONINTERACTIVE" ]; then NI=1; fi
pz() { [ -n "$NI" ] || read -r -p "${1:-按 Enter 继续…}" _; }
echo ""
echo "=============================================="
echo "  罗宾猫雷达 一键安装（Mac）"
echo "  官方 TG 群：t.me/nancy_c0813"
echo "=============================================="
echo ""
echo "【第 0 步】还没有币安 AI 钱包？用这个连结申请，开通时填邀请码 HI444QQY"
echo "  https://web3.binance.com/referral?ref=HI444QQY"
echo "  步骤：打开币安钱包 → 建立 AI 钱包 → 填邀请码 → 回来绑定。已经有钱包就跳过。"
echo ""
echo "开始前请确认：币安 App 里已开通 Agentic Wallet、领了 .ai Agent ID，并开启「开发者模式」"
pz "准备好了按 Enter 继续…"

# ---- 1. Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[1/5] 没有找到 Node.js"
  if command -v brew >/dev/null 2>&1; then
    echo "正在用 Homebrew 安装 Node.js…"; brew install node
  else
    echo "请先到 https://nodejs.org 下载 LTS 版（.pkg）安装，装好后再双击这个档一次。"
    open "https://nodejs.org/en/download"; pz "按 Enter 关闭…"; exit 1
  fi
fi
command -v node >/dev/null 2>&1 || { echo "Node.js 还没装好，装好后再执行一次"; pz; exit 1; }
# NODE-REQ：外挂沙盒（plugin-host.mjs 的 registerHooks）要 Node 22.15 以上
NODE_OK() { node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a>=24||(a==22&&b>=15)||(a==23&&b>=5))?0:1)"; }
if ! NODE_OK; then
  echo "你的 Node.js 版本太旧（$(node -v)），罗宾猫雷达需要 22.15 以上（外挂沙盒要用到）。"
  if command -v brew >/dev/null 2>&1; then echo "正在用 Homebrew 更新 Node.js…"; brew upgrade node 2>/dev/null || brew install node; hash -r; fi
  NODE_OK || { echo "请到 https://nodejs.org/en/download 下载 LTS 版（22.15 以上）安装后，再双击这个档一次"; pz; exit 1; }
fi
echo "[1/5] Node.js 已安装：$(node -v)"

# ---- 2. 币安 baw ----
# OPS-RT5：版本锁死在 baw2lock/package.json（跟第 2 个钱包用的 lock 档同一个来源）；装完核对 baw --version，版本不对就重装成锁定的版本。
# 不用 sudo：全域资料夹没权限就改用自己家目录的 npm 前缀（~/.npm-global），开机自启的 PATH 也会带上它
BAW_VER=$(node -p "require('./baw2lock/package.json').dependencies['@binance/agentic-wallet']" 2>/dev/null)
[ -n "$BAW_VER" ] || { echo "读不到 baw2lock/package.json 里的版本（安装档不完整？请重新下载官方安装包）"; pz; exit 1; }
NPM_USER_PREFIX="$HOME/.npm-global"; [ -d "$NPM_USER_PREFIX/bin" ] && export PATH="$NPM_USER_PREFIX/bin:$PATH"
bawv() { baw --version 2>/dev/null | tr -d '[:space:]'; }
if [ "$(bawv)" != "$BAW_VER" ]; then
  echo "[2/5] 正在安装币安 Agentic Wallet 工具（baw $BAW_VER，版本锁定）…"
  if ! npm install -g "@binance/agentic-wallet@$BAW_VER" --no-audit --no-fund; then
    echo "全域安装没有权限或失败，改装到 $NPM_USER_PREFIX（不用 sudo）…"
    mkdir -p "$NPM_USER_PREFIX" && npm config set prefix "$NPM_USER_PREFIX" && export PATH="$NPM_USER_PREFIX/bin:$PATH"
    npm install -g "@binance/agentic-wallet@$BAW_VER" --no-audit --no-fund || { echo "baw 安装失败，请检查网络后重新执行，或手动执行：npm install -g @binance/agentic-wallet@$BAW_VER"; pz; exit 1; }
  fi
  hash -r 2>/dev/null
fi
[ "$(bawv)" = "$BAW_VER" ] || { echo "baw 没有装成锁定的版本 $BAW_VER（现在：$(bawv)）。请检查网络后重新执行，或手动执行：npm install -g @binance/agentic-wallet@$BAW_VER"; pz; exit 1; }
echo "[2/5] baw $BAW_VER 已安装（版本核对过）"

# ---- 3. 设定 ----
mkdir -p data
echo "[3/5] 设定钱包和通知"
node setup.mjs "$@"
[ -f config.json ] || { echo "没有完成设定，请重新执行一次"; pz; exit 1; }

# ---- 4. 登录钱包 ----
echo ""
echo "[4/5] 登录第 1 个钱包：等一下会出现一个连结，用这个钱包的币安 App 打开并确认（5 分钟内）"
node login.mjs 1
NW=$(cat data_wallets.txt 2>/dev/null)
if [ "$NW" = "2" ]; then
  echo ""
  echo "登录第 2 个钱包：用第 2 个钱包的币安账号打开连结确认"
  mkdir -p baw2pkg baw2
  # OPS-RT5：只照 baw2lock/package-lock.json 装（npm ci：任何一个依赖内容跟 lock 档不符就中止），装完核对版本
  cp baw2lock/package.json baw2lock/package-lock.json baw2pkg/ && npm ci --prefix baw2pkg --no-audit --no-fund
  BAWV2=$(node baw2pkg/node_modules/@binance/agentic-wallet/dist/index.js --version 2>/dev/null | tr -d '[:space:]')
  [ "$BAWV2" = "$BAW_VER" ] || { echo "独立 baw 没有装成锁定的版本 $BAW_VER（现在：$BAWV2）。请检查网络后重新执行"; pz; exit 1; }
  [ -d baw2pkg/node_modules/@binance/agentic-wallet/node_modules/@github ] && mv baw2pkg/node_modules/@binance/agentic-wallet/node_modules/@github baw2pkg/keytar_disabled_1
  [ -d baw2pkg/node_modules/@github ] && mv baw2pkg/node_modules/@github baw2pkg/keytar_disabled_2
  node login.mjs 2
fi
rm -f data_wallets.txt

# ---- 4.5 罗宾猫雷达（桌面视窗）----
echo ""
echo "[罗宾猫雷达] 正在安装桌面视窗（第一次大约要 1～3 分钟）…"
# INST124：视窗元件（Electron）一开始就用国内镜像下载（大陆连 GitHub 常卡住不报错）；档案仍由 electron 套件内建的 SHA256 校验
( cd radar && export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" && if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --fetch-timeout=60000 --fetch-retries=2; else npm install --no-audit --no-fund --fetch-timeout=60000 --fetch-retries=2; fi )
# V104-ELEC：Electron 执行档不在＝下载失败（大陆常连不上 GitHub）→ 先用国内镜像直接重下，再不行用国内镜像重装；还是不行就不建桌面捷径、不开视窗，印原因和手动指令
if [ ! -d radar/node_modules/electron/dist/Electron.app ]; then
  echo "桌面视窗元件（Electron）没下载完整，改用国内镜像（npmmirror）再试一次…"
  [ -f radar/node_modules/electron/install.js ] && ( cd radar && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js )
  [ -d radar/node_modules/electron/dist/Electron.app ] || ( cd radar && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com )
fi
EOK=1; [ -d radar/node_modules/electron/dist/Electron.app ] || EOK=""
chmod +x "启动罗宾猫雷达-Mac.command" "start_loop.sh" 2>/dev/null
if [ -n "$EOK" ]; then
  ln -sf "$(pwd)/启动罗宾猫雷达-Mac.command" "$HOME/Desktop/罗宾猫雷达.command" && echo "桌面已建立「罗宾猫雷达」"
else
  echo ""
  echo "⚠️ 桌面视窗元件还是没装好（Electron 下载失败，常见原因：连不上 GitHub）。"
  echo "   这次先不建立桌面捷径；引擎照样会装好、在背景跑，自动买卖不受影响。"
  echo "   修好的方法（二选一）："
  echo "   1. 网络正常后（或开 VPN），再执行一次这个「一键安装-Mac.command」"
  echo "   2. 手动：打开「终端机」，依序输入下面两行（每行输完按回车键）："
  echo "      cd \"$(pwd)/radar\""
  echo "      ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci --registry=https://registry.npmmirror.com"
  echo "   装好后再执行一次安装档就会建立桌面捷径。"
fi

# ---- 5. 开机自动启动 + 现在启动 ----
echo ""
echo "[5/5] 设定开机自动启动"
PL="$HOME/Library/LaunchAgents/com.robincat.radar.engine.plist"
xe() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; } # 资料夹名字有 & < > 也不会弄坏设定档
HERE="$(xe "$(pwd)")"; NODE_DIR="$(xe "$(dirname "$(command -v node)")")"; NPM_BIN_DIR="$(xe "$(dirname "$(command -v baw)")")" # baw 装在哪（全域或 ~/.npm-global）开机自启都找得到
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.robincat.radar.engine</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$HERE/start_loop.sh</string></array>
<key>WorkingDirectory</key><string>$HERE</string>
<key>RunAtLoad</key><true/>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$NPM_BIN_DIR:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
EOF
launchctl unload "$PL" 2>/dev/null; launchctl load "$PL" && echo "已设定开机自动启动"
if [ -n "$EOK" ]; then open "$HOME/Desktop/罗宾猫雷达.command" 2>/dev/null || ./启动罗宾猫雷达-Mac.command & fi
echo ""
echo "=============================================="
if [ -n "$EOK" ]; then echo "  ✅ 安装完成，工具已在背景运行，罗宾猫雷达视窗也打开了"; else echo "  ✅ 安装完成，工具已在背景运行（桌面视窗元件没装好，视窗这次没打开，照上面的方法装好就行）"; fi
echo "  - 第一次打开雷达：输入邀请码、连接钱包；买卖条件全部预设关，自己开、自己填（没开就不会自动打）"
[ -n "$EOK" ] && echo "  - 桌面上的「罗宾猫雷达」可以随时打开视窗"
echo "  - 日志：data/watch.log"
echo "  - 停止：在这个资料夹建立一个叫 WATCH_STOP 的文件"
echo "  - Mac 要保持不睡眠（系统设定 → 电池／能源 → 防止自动睡眠），不然会漏单"
echo "  - 有新版时雷达右上角会提醒（TG 提醒要自己在设定打开）；在雷达按更新或 TG 回「更新」才会更新，更新失败不会自动退回旧版"
echo "  - 加入官方 TG 群：t.me/nancy_c0813"
echo "=============================================="
pz "按 Enter 关闭…"
