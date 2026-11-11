@echo off
cd /d "%~dp0"
if not exist data mkdir data
if exist start_loop.bat.new (
  move /y start_loop.bat.new start_loop.bat >nul
  echo [%date% %time%] start_loop.bat updated to the new version>> data\watch_console.log
  call "%~f0"
  exit /b
)
:: FIX-1112 user report: hundreds of leftover start_loop chains. Each chain now gives up after 30 failed starts in a row
:: (the radar starts a fresh one later if the engine is still down), and waits with ping instead of timeout (timeout fails without a console).
set FAILS=0
:loop
if exist WATCH_STOP goto end
node watch.mjs >> data\watch_console.log 2>&1
set RC=%errorlevel%
if "%RC%"=="9" goto end
if exist WATCH_STOP goto end
if "%RC%"=="0" (set FAILS=0) else if "%RC%"=="3" (set FAILS=0) else set /a FAILS+=1
if %FAILS% GEQ 30 (
  echo [%date% %time%] engine failed to start 30 times in a row, this launcher stops>> data\watch_console.log
  goto end
)
ping -n 6 127.0.0.1 >nul
goto loop
:end
