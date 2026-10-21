#!/usr/bin/env bash
# 服务器侧：为 鱼群bot 维护"推流是否在跑"的语义
#
# 背景：MC/推流栈在笔记本上，桥接在服务器上。桥接用 pidAlive(stream.pid) 判断推流状态，
#       而镜像过来的笔记本 PID 在服务器上无意义（kill -0 必然失败）。
#
# 做法：用两个服务器本地的客观信号合成这个判断——
#   ① 镜像的 stream.log 是否新鲜（mcsync 每 5 秒同步一次，推流在跑 → 日志一直在更新）
#   ② 端口桥进程是否活着
# 任一条不满足，就把 stream.pid 清空 → 桥接自然报 running=false。
#
# 同时顺带预热 25565 / 3200 端口桥（触发 systemd-socket-proxyd 常驻）。
set -u
LOG=/home/wx/mc/stream/stream.log
PIDFILE=/home/wx/mc/stream/stream.pid
STALE_SEC=90          # 日志超过这么久没更新，判定推流已停（渲染器每 15 秒写一次统计行）

# 1) 预热端口桥
for port in 25565 3200; do
  timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null || true
done
sleep 1

# 2) 更新 server.pid（桥接判断 MC 服务端是否可达）
mkdir -p /home/wx/mc/server/logs
PID=$(pgrep -f 'systemd-socket-proxyd .*10\.8\.0\.2:25565' | head -1)
if [ -n "${PID:-}" ]; then printf '%s\n' "$PID" > /home/wx/mc/server/logs/server.pid; fi

# 3) 更新 stream.pid（桥接判断推流是否在跑）
FRESH=0
if [ -f "$LOG" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$LOG") ))
  [ "$AGE" -lt "$STALE_SEC" ] && FRESH=1
fi
if [ "$FRESH" = "1" ] && [ -n "${PID:-}" ]; then
  printf '%s\n' "$PID" > "$PIDFILE"      # 用端口桥进程代表"推流在跑"（它确实常驻）
else
  : > "$PIDFILE"
fi
