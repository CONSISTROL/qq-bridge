#!/bin/sh
# 把「远程点选」用的虚拟屏 (:99) 挂成 noVNC，主人可以直接在网页里操作真浏览器。
# 端口：x11vnc 5900 → websockify 6080（noVNC 静态站 + WS）
set -e
DISPLAY_NUM="${DISPLAY_NUM:-:99}"
pgrep -f "Xvfb ${DISPLAY_NUM}" >/dev/null 2>&1 || (Xvfb "${DISPLAY_NUM}" -screen 0 1280x900x24 >/dev/null 2>&1 & sleep 1)
pgrep -f "x11vnc.*${DISPLAY_NUM}" >/dev/null 2>&1 || (x11vnc -display "${DISPLAY_NUM}" -nopw -listen 127.0.0.1 -rfbport 5900 -forever -shared -quiet >/tmp/x11vnc.log 2>&1 &)
sleep 1
pgrep -f "websockify.*6080" >/dev/null 2>&1 || (websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &)
sleep 1
echo "noVNC: http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale"
