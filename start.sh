#!/usr/bin/env bash
# QQ 桥接守护启动（Linux / macOS 版 start.bat）
#
# 与 start.bat 语义一致：
#   - 设置 QQ_BRIDGE_GUARDED=1：告诉桥接「有人守着」，控制台点「重启桥接」时它只退出，
#     由本脚本这个循环 5 秒后重新拉起（见 src/bridge.js 的 /api/restart）。
#   - 退出码 2 = 已有实例在运行（单实例锁被占）→ 直接结束，不要进重启循环。
#   - Ctrl+C / SIGTERM：转发给桥接并结束循环，不会傻乎乎地又拉起来。
#
# 用法：
#   ./start.sh                 # 前台守护（日志打在这个终端）
#   nohup ./start.sh >state/bridge-run.log 2>&1 &   # 后台守护（restart.sh 就是这么干的）
set -u

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
# 必须用 Node ≥ 21：SnowLuma SDK 依赖全局 WebSocket，Node 18 没有 → 启动即崩
# （线上真事：PATH 里 node 变成 /usr/bin/node v18，桥接一直启动失败刷屏）
NODE_BIN="${NODE_BIN:-$(command -v /opt/node22/bin/node 2>/dev/null || command -v node)}"
export QQ_BRIDGE_GUARDED=1
mkdir -p state

# 守护进程 PID：restart.sh / stop.sh 靠它精确地只杀守护，不误伤别的进程。
echo $$ > state/bridge-guard.pid
cleanup() {
  [ "$(cat state/bridge-guard.pid 2>/dev/null)" = "$$" ] && rm -f state/bridge-guard.pid
}
trap 'cleanup; exit 0' INT TERM

echo "[guard] 守护启动 pid=$$ （$NODE_BIN src/bridge.js）"
while true; do
  # 清理上一轮遗留的无头 Chrome。
  # 为什么需要：src/browser-render.js 会拉起 puppeteer/Chromium，靠一个
  # idleTimer 在空闲后自己关闭。但桥接进程一旦退出（重启/崩溃），这个定时器
  # 随之消失，Chrome 就变成 PPID=1 的孤儿进程**永远不关**。
  # 实测：一次重启遗留 12 个 Chrome 进程、吃掉 57% CPU，把整机 load 抬到 15，
  # 进而导致桥接访问 DSH 的 API 超时（日志表现成反复「DSH 不可用」）。
  # 守护循环每次拉起桥接前清一次是安全的：此刻不可能有「本实例的」浏览器在跑。
  if command -v pkill >/dev/null 2>&1; then
    pkill -9 -f 'chrome-linux64/chrome' 2>/dev/null || true
  fi

  "$NODE_BIN" src/bridge.js &
  child=$!
  wait "$child"
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "[guard] 已有实例在运行（单实例锁被占），守护退出"
    cleanup
    exit 2
  fi
  echo "[guard] 桥接退出（code $code），5 秒后重启…"
  sleep 5
done
