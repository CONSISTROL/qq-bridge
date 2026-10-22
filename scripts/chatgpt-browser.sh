#!/bin/sh
# 打开/关闭一个「已带代理」的 Chrome，专供登录 ChatGPT 用（不依赖 puppeteer，进程常驻）。
# 用法：sh scripts/chatgpt-browser.sh start|stop|status
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="$DIR/state/chatgpt-profile"
PROXY="${DRAW_PROXY:-http://127.0.0.1:7897}"
DISPLAY_NUM="${DRAW_DISPLAY:-:42}"
URL="${1:-}"
case "$2" in
  start) ;;
esac
cmd_start() {
  mkdir -p "$PROFILE"
  for f in SingletonLock SingletonSocket SingletonCookie; do rm -f "$PROFILE/$f"; done
  DISPLAY="$DISPLAY_NUM" setsid nohup /usr/bin/google-chrome \
    --no-sandbox --disable-dev-shm-usage --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check \
    --proxy-server="$PROXY" --window-size=1280,1000 --window-position=0,0 --start-maximized \
    "https://chatgpt.com/" > /tmp/chatgpt-chrome.log 2>&1 < /dev/null &
  sleep 3
  echo "已启动：DISPLAY=$DISPLAY_NUM 代理=$PROXY profile=$PROFILE"
}
cmd_stop() { pkill -f "chatgpt-profile" 2>/dev/null; echo "已停止"; }
cmd_status() { pgrep -af "chrome.*chatgpt-profile" | head -2; }
case "${1:-status}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  *) cmd_status ;;
esac
