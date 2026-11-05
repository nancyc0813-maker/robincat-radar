@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 罗宾猫雷达 一键安装
REM H2：带参数（--name1 … --addr1 …）或设了 RC_NONINTERACTIVE（AI 帮忙执行）→ 不停下来等按键
set "NI="
if not "%~1"=="" set "NI=1"
if defined RC_NONINTERACTIVE set "NI=1"
echo.
echo ==============================================
echo   罗宾猫雷达 一键安装
echo   官方 TG 群：t.me/nancy_c0813
echo ==============================================
echo.
echo 【第 0 步】还没有币安 AI 钱包？用这个连结申请，开通时填邀请码 HI444QQY
echo   https://web3.binance.com/referral?ref=HI444QQY
echo   步骤：打开币安钱包 → 建立 AI 钱包 → 填邀请码 → 回来绑定。已经有钱包就跳过。
echo.
echo 开始前请确认：币安 App 里已开通 Agentic Wallet、领了 .ai Agent ID，并开启「开发者模式」
echo.
if not defined NI pause

REM ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [1/5] 没有找到 Node.js，正在安装...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
)
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js 安装完成。请【关掉这个窗口，再重新双击 一键安装.bat】继续。
  echo 如果安装失败，请到 https://nodejs.org 下载 LTS 版手动安装后再执行一次。
  if not defined NI pause
  exit /b 1
)
REM NODE-REQ：外挂沙盒（plugin-host.mjs 的 registerHooks）要 Node 22.15 以上
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a>=24||(a==22&&b>=15)||(a==23&&b>=5))?0:1)"
if errorlevel 1 (
  echo 你的 Node.js 版本太旧，罗宾猫雷达需要 22.15 以上（外挂沙盒要用到），正在用 winget 更新...
  winget upgrade -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo 更新完请【关掉这个窗口，再重新双击 一键安装.bat】；更新失败请到 https://nodejs.org/en/download 下载 LTS 版（22.15 以上）安装后再执行一次
  if not defined NI pause
  exit /b 1
)
echo [1/5] Node.js 已安装

REM ---- 2. 币安 baw ----
REM OPS-RT5：版本锁死在 baw2lock\package.json（跟第 2 个钱包用的 lock 档同一个来源）；装完核对 baw --version，版本不对就重装成锁定的版本
set "BAW_VER="
for /f "usebackq delims=" %%v in (`node -p "require('./baw2lock/package.json').dependencies['@binance/agentic-wallet']"`) do set "BAW_VER=%%v"
if not defined BAW_VER (
  echo 读不到 baw2lock\package.json 里的版本（安装档不完整？请重新下载官方安装包）
  if not defined NI pause
  exit /b 1
)
set "BAWV="
for /f "usebackq delims=" %%v in (`baw --version 2^>nul`) do set "BAWV=%%v"
if not "%BAWV%"=="%BAW_VER%" (
  echo [2/5] 正在安装币安 Agentic Wallet 工具（baw %BAW_VER%，版本锁定）...
  call npm install -g @binance/agentic-wallet@%BAW_VER% --no-audit --no-fund
  set "PATH=%PATH%;%APPDATA%\npm"
)
set "BAWV="
for /f "usebackq delims=" %%v in (`baw --version 2^>nul`) do set "BAWV=%%v"
if not "%BAWV%"=="%BAW_VER%" (
  echo baw 没有装成锁定的版本 %BAW_VER%（现在：%BAWV%）。请检查网络后重新执行，或手动执行：npm install -g @binance/agentic-wallet@%BAW_VER%
  if not defined NI pause
  exit /b 1
)
echo [2/5] baw %BAW_VER% 已安装（版本核对过）

REM ---- 3. 设定 ----
if not exist data mkdir data
echo [3/5] 设定钱包和通知
node setup.mjs %*
if not exist config.json (
  echo 没有完成设定，请重新执行一次
  if not defined NI pause
  exit /b 1
)

REM ---- 4. 登录钱包 ----
echo.
echo [4/5] 登录第 1 个钱包：等一下会出现一个连结，用这个钱包的币安 App 打开并确认（5 分钟内）
node login.mjs 1
set /p NW=<data_wallets.txt
if "%NW%"=="2" (
  echo.
  echo 登录第 2 个钱包：用第 2 个钱包的币安账号打开连结确认
  call setup_wallet2.bat
)
del data_wallets.txt >nul 2>nul

REM ---- 4.5 罗宾猫雷达（桌面视窗）----
echo.
echo [罗宾猫雷达] 正在安装桌面视窗（第一次大约要 1～3 分钟）...
pushd radar
if exist package-lock.json (call npm ci --no-audit --no-fund) else (call npm install --no-audit --no-fund)
popd
REM V104-ELEC：electron.exe 不在＝下载失败（大陆常连不上 GitHub）→ 先用国内镜像直接重下，再不行用国内镜像重装；还是不行就不建桌面捷径、不开视窗，印原因和手动指令
if not exist radar\node_modules\electron\dist\electron.exe (
  echo 桌面视窗元件（Electron）没下载完整，改用国内镜像（npmmirror）再试一次...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  if exist radar\node_modules\electron\install.js node radar\node_modules\electron\install.js
)
if not exist radar\node_modules\electron\dist\electron.exe (
  echo 还是没有，改用国内镜像重新安装桌面视窗元件...
  pushd radar
  call npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com
  popd
)
set "EOK=1"
if not exist radar\node_modules\electron\dist\electron.exe set "EOK="
if defined EOK goto :desk_link
echo.
echo ⚠️ 桌面视窗元件还是没装好（Electron 下载失败，常见原因：连不上 GitHub）。
echo    这次先不建立桌面捷径（免得点了跳「系统找不到指定的文件」）；引擎照样会装好、在背景跑，自动买卖不受影响。
echo    修好的方法（二选一）：
echo    1. 网络正常后（或开 VPN），再执行一次这个「一键安装.bat」
echo    2. 手动：打开「命令提示符」（cmd），依序输入下面三行，每行按 Enter：
echo       cd /d "%~dp0radar"
echo       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
echo       npm ci --registry=https://registry.npmmirror.com
echo    装好后再执行一次「一键安装.bat」就会建立桌面捷径。
goto :desk_done
:desk_link
REM 桌面捷径（DESKLNK-108）：建真正的 Windows 捷径「罗宾猫雷达.lnk」（猫头图示，指向 radar\启动罗宾猫雷达.vbs）；用 Windows 真正的桌面位置（开了 OneDrive 备份时桌面在 OneDrive 里）；建不成才退回旧的 .vbs；旧的 .vbs 只有内容确认是本雷达的才删
node "%~dp0radar\desklink.cjs" install
:desk_done

REM ---- 5. 开机自动启动 + 现在启动 ----
echo.
echo [5/5] 设定开机自动启动
node -e "const p=require('path'),fs=require('fs');const f=p.join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Startup','robincat-radar-engine.vbs');const t='CreateObject(\"WScript.Shell\").Run \"\"\"'+p.join(process.cwd(),'start_hidden.vbs')+'\"\"\", 0, False\r\n';fs.writeFileSync(f,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(t,'utf16le')]));console.log('已设定开机自动启动')"
start "" wscript "%~dp0start_hidden.vbs"
if defined EOK start "" wscript "%~dp0radar\启动罗宾猫雷达.vbs"
echo.
echo ==============================================
if defined EOK echo   ✅ 安装完成，工具已在背景运行，罗宾猫雷达视窗也打开了
if not defined EOK echo   ✅ 安装完成，工具已在背景运行（桌面视窗元件没装好，视窗这次没打开，照上面的方法装好就行）
echo   - 第一次打开雷达：输入邀请码、连接钱包；买卖条件全部预设关，自己开、自己填（没开就不会自动打）
if defined EOK echo   - 桌面上的「罗宾猫雷达」可以随时打开视窗
echo   - 日志：data\watch.log
echo   - 停止：在这个资料夹建立一个叫 WATCH_STOP 的文件
echo   - 有新版时雷达右上角会提醒（TG 提醒要自己在设定打开）；在雷达按更新或 TG 回「更新」才会更新，更新失败不会自动退回旧版
echo   - 加入官方 TG 群：t.me/nancy_c0813
echo ==============================================
if not defined NI pause
