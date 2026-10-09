#!/usr/bin/env bash
# 把笔记本的 MC 状态单向镜像到服务器，供 qq-bridge 读取
#
# 背景：MC 栈迁到笔记本(10.8.0.2)后，服务器上的 qq-bridge 用 MC_ROOT 读本地文件，
#       读不到笔记本 → 控制台的 MC 视图/里程碑/指令投递全瞎。
# 做法：笔记本主动把状态 rsync 到服务器；桥接仍读本地路径，零代码改动。
#
# 方向：
#   bot-state.json / milestone-state.json / bot.log / server.pid / server.properties
#   / stream-config.json / room.json   → 笔记本 → 服务器（只读镜像）
#   bot-command.txt                    → 服务器 → 笔记本（拉取，bot 轮询消费后清空）
#
# 用法: mcsync-daemon.sh          常驻循环（systemd 用）
#       mcsync-daemon.sh --once   只同步一次（调试）
set -u
export LC_ALL=C

MIRROR="${MCSYNC_MIRROR:-/home/wx/mc-mirror}"
LOCAL=/home/wx/mc
KEY="$HOME/.ssh/mcsync_key"
SERVER=root@10.8.0.1
INTERVAL="${MCSYNC_INTERVAL:-5}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

SSH_CMD="ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=$HOME/.ssh/known_hosts -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4"

mkdir -p "$MIRROR/bot" "$MIRROR/server/logs" "$MIRROR/stream"
log() { echo "[$(date '+%F %T')] $*"; }

# 待同步清单写文件，避免用 `--files-from=-` 时 rsync 的 ssh 与 stdin 抢数据
LIST=$(mktemp /tmp/mcsync-list.XXXXXX)
trap 'rm -f "$LIST"' EXIT
cat > "$LIST" <<'EOF'
bot/bot-state.json
bot/milestone-state.json
bot/bot.log
server/server.properties
stream/stream-config.json
stream/room.json
EOF

sync_once() {
  # 1) 笔记本 → 服务器：状态镜像（缺文件不报错）
  rsync -az --timeout=15 --files-from="$LIST" -e "$SSH_CMD" \
    "$LOCAL/" "$SERVER:$MIRROR/" >/dev/null 2>&1 || return 1

  # 2) 服务器 → 笔记本：拉取桥接投递的指令（文件不存在时忽略）
  rsync -az --timeout=15 -e "$SSH_CMD" \
    "$SERVER:$MIRROR/bot/bot-command.txt" "$LOCAL/bot/bot-command.txt" >/dev/null 2>&1 || true

  return 0
}

if [ "$ONCE" = "1" ]; then
  if sync_once; then log "单次同步完成"; else log "同步失败"; fi
  exit 0
fi

log "mcsync 启动：$LOCAL → $SERVER:$MIRROR 每 ${INTERVAL}s"
FAILS=0
while true; do
  if sync_once; then
    FAILS=0
  else
    FAILS=$((FAILS+1))
    [ $((FAILS % 12)) -eq 1 ] && log "同步失败（第 $FAILS 次），隧道可能不通"
  fi
  sleep "$INTERVAL"
done
