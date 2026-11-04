@echo off
cd /d "%~dp0"
if not exist data mkdir data
if exist start_loop.bat.new (
  move /y start_loop.bat.new start_loop.bat >nul
  echo [%date% %time%] start_loop.bat updated to the new version>> data\watch_console.log
  call "%~f0"
  exit /b
)
:loop
if exist WATCH_STOP goto end
node watch.mjs >> data\watch_console.log 2>&1
set RC=%errorlevel%
if "%RC%"=="9" goto end
if exist WATCH_STOP goto end
timeout /t 5 /nobreak >nul
goto loop
:end
