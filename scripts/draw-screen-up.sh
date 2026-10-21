#!/bin/sh
# 为「画图远程操作」准备一套独立的虚拟桌面：Xvfb + openbox + x11vnc + websockify
# 用途：豆包 web 每次要过语义验证码，靠截图转发不好用，直接给个真桌面让主人自己点。
# 用法：sh scripts/draw-screen-up.sh [显示号] [分辨率]
set -u
D="${1:-:99}"
RES="${2:-1280x800}"
PORT_VNC=5902
PORT_WS=6083

# 1) X 虚拟屏
pgrep -f "Xvfb ${D} " >/dev/null 2>&1 || {
  setsid nohup Xvfb "${D}" -screen 0 "${RES}x24" -nolisten tcp >/tmp/xvfb-draw.log 2>&1 < /dev/null &
  sleep 2
}
# 2) 窗口管理器（没有 WM 时浏览器不会铺满屏幕）
pgrep -f "openbox" >/dev/null 2>&1 || {
  DISPLAY="${D}" setsid nohup openbox >/tmp/openbox-draw.log 2>&1 < /dev/null &
  sleep 1
}
# 3) x11vnc
pgrep -f "x11vnc.*display ${D}" >/dev/null 2>&1 || {
  setsid nohup x11vnc -display "${D}" -nopw -localhost -rfbport "${PORT_VNC}" -forever -shared -quiet >/tmp/x11vnc-draw.log 2>&1 < /dev/null &
  sleep 2
}
# 4) websockify + noVNC 静态站
pgrep -f "websockify.*${PORT_WS}" >/dev/null 2>&1 || {
  setsid nohup websockify --web /usr/share/novnc "127.0.0.1:${PORT_WS}" "127.0.0.1:${PORT_VNC}" >/tmp/websockify-draw.log 2>&1 < /dev/null &
  sleep 2
}
echo "显示 ${D} (${RES}) 就绪；noVNC: http://127.0.0.1:${PORT_WS}/vnc.html"
