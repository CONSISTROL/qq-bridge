@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 告诉桥接「有人守着」：控制台的「重启桥接」在这种情况下只退出，由下面这个循环 5 秒后拉起；
rem 手动 node src/bridge.js 时没有这个变量，桥接会自己 detached 拉一个新进程，否则按钮一按就永久下线。
set QQ_BRIDGE_GUARDED=1
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop
