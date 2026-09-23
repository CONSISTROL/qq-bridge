#!/usr/bin/env bash
# 看一眼桥接现在什么状态：守护 / 主进程 / 单实例锁 / 控制台端口 / 最近日志。
# 用法：./status.sh
set -u

cd "$(dirname "$0")" || exit 1

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

guard="$(cat state/bridge-guard.pid 2>/dev/null || true)"
bridge="$(cat state/bridge.lock 2>/dev/null || true)"

if alive "$guard"; then echo "守护循环 : ✅ pid=$guard （start.sh）"; else echo "守护循环 : ❌ 未运行${guard:+（残留 pid=$guard）}"; fi
if alive "$bridge"; then
  echo "桥接进程 : ✅ pid=$bridge"
  ps -o pid,ppid,etime,rss,cmd -p "$bridge" 2>/dev/null | tail -1 | sed 's/^/           /'
else
  echo "桥接进程 : ❌ 未运行${bridge:+（锁里 pid=$bridge 已死，属残留锁，可 ./restart.sh）}"
fi

port="$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('config.json','utf8')).consolePort||3100)}catch{console.log(3100)}" 2>/dev/null || echo 3100)"
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${port}/api/status" 2>/dev/null || echo 000)"
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then echo "控制台   : ✅ http://127.0.0.1:${port} （HTTP $code，401=需要令牌）"; else echo "控制台   : ❌ 无响应（HTTP $code）"; fi
fi

echo "最近日志 :"
tail -5 state/bridge.log 2>/dev/null | sed 's/^/           /' || echo "           （暂无 state/bridge.log）"
