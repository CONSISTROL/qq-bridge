#!/usr/bin/env bash
# 重启 QQ 桥接（Linux / macOS 版 restart.bat）：
#   停旧守护与桥接 → 清锁 → 后台拉起新的守护（start.sh），日志进 state/bridge-run.log。
#
# 用法：
#   ./restart.sh            # 后台守护（默认，关掉终端也不影响）
#   ./restart.sh --fg       # 前台守护（日志直接打在终端，Ctrl+C 退出）
set -u

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
LOG=state/bridge-run.log
mkdir -p state

# stop.sh 优先用 ./ 调用（保持可执行位语义）；没有执行位（如 Windows 检出/拷贝丢权限）就用 bash 兜底。
if [ -x ./stop.sh ]; then ./stop.sh || true; else bash ./stop.sh || true; fi

if [ "${1:-}" = "--fg" ]; then
  exec bash ./start.sh
fi

# nohup：关掉终端不会被 SIGHUP 带走；日志同时由桥接自己写进 state/bridge.log
nohup bash ./start.sh >>"$LOG" 2>&1 &
guard=$!
sleep 1

if kill -0 "$guard" 2>/dev/null; then
  bridge_pid="$(cat state/bridge.lock 2>/dev/null || echo '')"
  echo "[restart] 守护已启动（guard pid=$guard${bridge_pid:+, bridge pid=$bridge_pid}）"
  echo "[restart] 日志：state/bridge.log（桥接自有）与 $LOG（守护/启动输出）"
else
  echo "[restart] ❌ 守护启动失败，看 $LOG"
  exit 1
fi
