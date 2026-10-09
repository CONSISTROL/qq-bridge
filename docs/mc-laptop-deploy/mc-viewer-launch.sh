#!/usr/bin/env bash
# 启动 Chrome kiosk 打开 prismarine-viewer 页面（供 X11 抓屏推流）
#
# 为什么用包装脚本而不是 systemd 的 Environment=DISPLAY：
#   实测 drop-in 里的 Environment=DISPLAY=:99 不生效（systemd 显示 Environment 为空），
#   导致 Chrome 报 "Missing X server or $DISPLAY"。在脚本里 export 最可靠。
set -u

export DISPLAY="${MC_VIEWER_DISPLAY:-:99}"
export HOME=/home/wx

URL="${MC_VIEWER_URL:-http://127.0.0.1:3200/}"
PROFILE=/home/wx/.mc-viewer-chrome

# 等 X server 就绪（最多 30 秒）
for i in $(seq 1 30); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
  echo "[viewer] ❌ X server $DISPLAY 不可用" >&2
  exit 1
fi

# 等 viewer 页面可用（botd 起的 HTTP 服务，最多 60 秒）
for i in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 3 "$URL"; then break; fi
  sleep 1
done

# 清理上次异常退出留下的单例锁，否则 Chrome 会拒绝启动
rm -f "$PROFILE"/Singleton* 2>/dev/null || true

echo "[viewer] 启动 Chrome：DISPLAY=$DISPLAY URL=$URL"
exec /usr/bin/google-chrome \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check --disable-infobars \
  --disable-session-crashed-bubble --hide-scrollbars --mute-audio \
  --no-sandbox --disable-dev-shm-usage \
  --use-gl=angle --enable-gpu-rasterization --ignore-gpu-blocklist \
  --disable-gpu-vsync --disable-frame-rate-limit \
  --remote-debugging-port=9222 \
  --kiosk --window-size=1920,1080 --window-position=0,0 \
  "$URL"
