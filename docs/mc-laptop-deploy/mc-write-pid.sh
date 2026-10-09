#!/usr/bin/env bash
# 把 mcserver 的 MainPID 写进 logs/server.pid
#
# 为什么需要：服务器上的 qq-bridge（src/mc-state.js）用 pidAlive(logs/server.pid)
# 判断"MC 服务端在跑"。改用 systemd 管理后不再有脚本写这个文件，
# 控制台就会一直显示服务端未运行。
set -u
PIDDIR=/home/wx/mc/server/logs
mkdir -p "$PIDDIR"
PID="$(systemctl show mcserver -p MainPID --value 2>/dev/null)"
if [ -n "${PID:-}" ] && [ "$PID" != "0" ]; then
  printf '%s\n' "$PID" > "$PIDDIR/server.pid"
else
  : > "$PIDDIR/server.pid"
fi
