@echo off
chcp 65001 >nul
cd /d "%~dp0"
REM 第二个钱包用独立的 baw 副本：停用系统钥匙圈（keytar），session 存在 baw2 资料夹，不会跟第一个钱包互相踢下线
REM OPS-RT5：版本锁死——只照 baw2lock\package-lock.json 装（npm ci：任何一个依赖内容跟 lock 档不符就中止），装完核对版本
if not exist baw2lock\package-lock.json (
  echo 找不到 baw2lock\package-lock.json（安装档不完整？请重新下载官方安装包）
  if not defined NI pause
  exit /b 1
)
if not exist baw2pkg mkdir baw2pkg
copy /y baw2lock\package.json baw2pkg\package.json >nul
copy /y baw2lock\package-lock.json baw2pkg\package-lock.json >nul
call npm ci --prefix baw2pkg --no-audit --no-fund
set "BAW_VER="
for /f "usebackq delims=" %%v in (`node -p "require('./baw2lock/package.json').dependencies['@binance/agentic-wallet']"`) do set "BAW_VER=%%v"
set "BAWV2="
for /f "usebackq delims=" %%v in (`node baw2pkg\node_modules\@binance\agentic-wallet\dist\index.js --version 2^>nul`) do set "BAWV2=%%v"
if not "%BAWV2%"=="%BAW_VER%" (
  echo 独立 baw 没有装成锁定的版本 %BAW_VER%（现在：%BAWV2%）。请检查网络后重新执行 setup_wallet2.bat
  if not defined NI pause
  exit /b 1
)
if exist baw2pkg\node_modules\@binance\agentic-wallet\node_modules\@github move baw2pkg\node_modules\@binance\agentic-wallet\node_modules\@github baw2pkg\keytar_disabled_1
if exist baw2pkg\node_modules\@github move baw2pkg\node_modules\@github baw2pkg\keytar_disabled_2
if not exist baw2 mkdir baw2
node login.mjs 2
if not defined NI pause
