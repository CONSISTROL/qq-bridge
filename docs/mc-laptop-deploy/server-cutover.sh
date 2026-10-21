#!/usr/bin/env bash
# 服务器侧收尾：把 鱼群bot 读的 MC 路径切到镜像，并把 3200 桥到笔记本
#
# 1) /home/wx/mc → /home/wx/mc-mirror（旧目录原样保留，可秒回滚）
# 2) 127.0.0.1:3200 → 10.8.0.2:3200（nginx 的 /mc/ 反代依赖它）
set -u
export LC_ALL=C

MIRROR=/home/wx/mc-mirror
OLD="/home/wx/mc.old-server-$(date +%Y%m%d-%H%M%S)"

echo "########## 服务器侧衔接 $(date '+%F %T') ##########"

echo
echo "=== [1/4] 检查是否有进程占用旧目录 ==="
BUSY=$(for p in /proc/[0-9]*; do
  cwd=$(readlink "$p/cwd" 2>/dev/null) || continue
  case "$cwd" in /home/wx/mc|/home/wx/mc/*) echo "${p#/proc/}: $cwd";; esac
done | head -5)
if [ -n "$BUSY" ]; then echo "⚠️ 有进程工作目录在旧目录里："; echo "$BUSY"; else echo "✅ 无进程占用"; fi

echo
echo "=== [2/4] 切换目录（旧目录保留为 $OLD）==="
if [ -L /home/wx/mc ]; then
  echo "已经是符号链接，跳过：$(readlink /home/wx/mc)"
elif [ -d /home/wx/mc ]; then
  mv /home/wx/mc "$OLD" && ln -s "$MIRROR" /home/wx/mc && echo "✅ /home/wx/mc → $MIRROR（旧目录在 $OLD）"
else
  echo "❌ /home/wx/mc 不存在，中止"; exit 1
fi
ls -ld /home/wx/mc "$OLD" 2>/dev/null

echo
echo "=== [3/4] 写入 3200 端口桥单元 ==="
cat > /etc/systemd/system/mc-viewer-proxy.socket <<'SOCK'
[Unit]
Description=MC 网页地图 viewer 端口桥（本机 3200 → 笔记本 10.8.0.2:3200）
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Socket]
ListenStream=127.0.0.1:3200
Accept=no
ProxyTo=10.8.0.2:3200

[Install]
WantedBy=sockets.target
SOCK

cat > /etc/systemd/system/mc-viewer-proxy.service <<'SVC'
[Unit]
Description=MC viewer 端口桥的转发进程
After=network-online.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
Type=simple
ExecStart=/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=300 10.8.0.2:3200
Restart=always
RestartSec=5
NoNewPrivileges=true
SVC

systemctl daemon-reload
systemctl enable --now mc-viewer-proxy.socket 2>&1 | tail -2

echo
echo "=== [4/4] 验证 ==="
sleep 3
echo "--- viewer 桥 ---"
systemctl is-active mc-viewer-proxy.socket
ss -ltn | grep 3200 || echo "❌ 3200 未监听"
echo "--- 端口桥实测（HTTP 200 = 通到笔记本 viewer）---"
curl -s -o /dev/null -w "本机 3200 → %{http_code} (%{time_total}s)\n" --max-time 10 http://127.0.0.1:3200/ 2>&1
echo "--- 桥接读到的 MC 路径 ---"
ls -ld /home/wx/mc
cat /home/wx/mc/bot/bot-state.json 2>/dev/null | head -c 200; echo
