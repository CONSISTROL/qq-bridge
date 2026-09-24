#!/usr/bin/env bash
# 停掉 QQ 桥接（守护循环 + 桥接进程 + 它 spawn 的 embedder 子进程），并清理单实例锁。
#
# 顺序很重要：**先停守护循环**，否则刚杀掉桥接，start.sh 的循环 5 秒后又把它拉起来。
# 优先按 PID 精确杀（state/bridge-guard.pid / state/bridge.lock），最后才按 argv 兜底匹配
# （只认「确实在用 node 跑这个脚本」的进程，见 is_node_script_pid）。
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

# 读一个进程的 argv，一行一个参数。
# Linux 直接读 /proc/<pid>/cmdline（NUL 分隔）——这是唯一可靠的方式，不受引号/空格影响。
# 拿不到 /proc（macOS 等）时退化为 ps 整行按空白切分：路径里带空格会切错，
# 但我们的进程路径没有空格，且判不准时只会「少杀」并给出提示，不会误杀。
proc_argv() {
  local pid="$1" item
  if [ -r "/proc/$pid/cmdline" ]; then
    while IFS= read -r -d '' item; do printf '%s\n' "$item"; done < "/proc/$pid/cmdline"
    return 0
  fi
  ps -o args= -p "$pid" 2>/dev/null | tr -s ' \t' '\n' | sed '/^$/d'
}

# 这个 PID 是不是「真的在用 node 跑 $2 这个脚本（相对路径形式）」？
#
# 为什么不能用 pkill -f 'node .*src/bridge\.js'：那只是命令行**子串**匹配，凡是命令行里
# 出现过这个路径的进程都会中枪。实测事故：`node --check src/bridge.js && ./restart.sh`
# 这条命令执行时，restart.sh → stop.sh 的 pkill 把**调用它的那个 shell 自己**杀了
# （bash 的 cmdline 里含 `node --check src/bridge.js`），命令直接 SIGTERM 中断。
# 编辑器、`grep src/bridge.js`、`tail` 之类同理。
#
# 判据（argv 层面，而不是字符串层面）：
#   1) argv 里有一个 node/nodejs 可执行文件（允许 `systemd-run … node …` 这类前缀）；
#   2) 该 node 之后有一个参数正好是目标脚本（`src/bridge.js` 或 `…/src/bridge.js`）；
#   3) 两者之间没有 --check/-c/-e/--eval/-p/--print 这类「跑了但不是跑服务」的开关。
is_node_script_pid() {
  local pid="$1" script="$2" node_idx=-1 i arg found=0
  local -a argv=()
  while IFS= read -r arg; do argv+=("$arg"); done < <(proc_argv "$pid")
  [ "${#argv[@]}" -gt 0 ] || return 1
  for i in "${!argv[@]}"; do
    # 用参数展开而不是 basename：argv 里可能是 `-c` 这类以横杠开头的普通参数，
    # 交给 basename 会被当成选项，往 stderr 吐 "Try 'basename --help'"。
    case "${argv[$i]##*/}" in
      node|nodejs) node_idx=$i; break ;;
    esac
  done
  [ "$node_idx" -ge 0 ] || return 1
  for ((i = node_idx + 1; i < ${#argv[@]}; i++)); do
    arg="${argv[$i]}"
    case "$arg" in
      --check|-c|--eval|-e|--print|-p) return 1 ;;
    esac
    case "$arg" in
      "$script"|*/"$script") found=1 ;;
    esac
  done
  [ "$found" -eq 1 ]
}

# 兜底清理：只杀「确实在用 node 跑这个脚本」的进程（见 is_node_script_pid 的事故说明）。
kill_node_scripts() {
  local script="$1" label="$2" pid killed=0
  for pid in $(pgrep -f "$script" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    is_node_script_pid "$pid" "$script" || continue
    kill_wait "$pid" "$label"
    killed=$((killed + 1))
  done
  return 0
}

# 还有没有残留（同样只认真正的 node 进程）。
list_node_script_pids() {
  local script="$1" pid out=""
  for pid in $(pgrep -f "$script" 2>/dev/null || true); do
    [ "$pid" = "$$" ] && continue
    is_node_script_pid "$pid" "$script" && out="$out $pid"
  done
  printf '%s' "${out# }"
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

# 3) 兜底：锁文件被误删 / 进程换了父进程时，按 argv 匹配（相对路径 node src/bridge.js 也能命中）。
#    这里**不能**退回 pkill -f 子串匹配——见 is_node_script_pid 里那条「把自己调用方杀掉」的事故。
kill_node_scripts 'src/bridge.js' "桥接"
sleep 0.5
kill_node_scripts 'src/embedder.js' "embedder 子进程"

# 4) 清锁与守护 PID：进程都停了还留着，下次启动会误报「已有实例在运行」
rm -f state/bridge.lock state/bridge-guard.pid
residual="$(list_node_script_pids 'src/bridge.js')"
if [ -n "$residual" ]; then
  echo "[stop] ⚠️ 仍有桥接进程残留（pid ${residual// /, }），请手动检查：ps -o pid=,args= -p ${residual// /,}"
else
  echo "[stop] 已停止，锁已清理"
fi
