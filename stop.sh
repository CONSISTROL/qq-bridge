#!/usr/bin/env bash
# 停掉 QQ 桥接（守护循环 + 桥接进程 + 它 spawn 的 embedder 子进程），并清理单实例锁。
#
# 顺序很重要：**先停守护循环**，否则刚杀掉桥接，start.sh 的循环 5 秒后又把它拉起来。
# 优先按 PID 精确杀（state/bridge-guard.pid / state/bridge.lock），最后才用命令行兜底匹配。
# 桥接自己处理 SIGINT/SIGTERM（会 releaseLock 后退出），所以默认用 SIGTERM，超时才 SIGKILL。
#
# 用法：./stop.sh
set -u

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"

kill_wait() {
  local pid="$1" name="$2" i
  [ -n "${pid:-}" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  echo "[stop] 停 $name pid=$pid"
  kill "$pid" 2>/dev/null || true
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  echo "[stop] $name 5 秒内没退出，强杀"
  kill -9 "$pid" 2>/dev/null || true
}

# 1) 守护循环（start.sh）
if [ -f state/bridge-guard.pid ]; then
  kill_wait "$(cat state/bridge-guard.pid 2>/dev/null || true)" "守护循环"
  rm -f state/bridge-guard.pid
fi

# 2) 桥接主进程：state/bridge.lock 里存的就是它的 PID
if [ -f state/bridge.lock ]; then
  kill_wait "$(cat state/bridge.lock 2>/dev/null || true)" "桥接"
fi

# 3) 兜底：锁文件被误删 / 进程换了父进程时，按命令行匹配（相对路径 node src/bridge.js 也能命中）
pkill -f 'node .*src/bridge\.js' 2>/dev/null || true
sleep 0.5
pkill -f 'node .*src/embedder\.js' 2>/dev/null || true

# 4) 清锁与守护 PID：进程都停了还留着，下次启动会误报「已有实例在运行」
rm -f state/bridge.lock state/bridge-guard.pid
if pgrep -f 'node .*src/bridge\.js' >/dev/null 2>&1; then
  echo "[stop] ⚠️ 仍有桥接进程残留，请手动检查：pgrep -af 'src/bridge.js'"
else
  echo "[stop] 已停止，锁已清理"
fi
