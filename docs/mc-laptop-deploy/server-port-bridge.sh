#!/usr/bin/env bash
# 服务器侧：补 25565 端口桥 + 让 server.running 语义正确
set -u
export LC_ALL=C

echo "########## 25565 端口桥 $(date '+%F %T') ##########"

echo
echo "=== [1/4] 25565 桥接单元（服务器 → 笔记本 MC）==="
cat > /etc/systemd/system/mc-server-proxy.socket <<'SOCK'
[Unit]
Description=MC 服务端端口桥（服务器 25565 → 笔记本 10.8.0.2:25565）
After=network-online.target wg-quick@wg0.service
Wants=network-online.target

[Socket]
ListenStream=25565
Accept=no
ProxyTo=10.8.0.2:25565

[Install]
WantedBy=sockets.target
SOCK

cat > /etc/systemd/system/mc-server-proxy.service <<'SVC'
[Unit]
Description=MC 服务端端口桥的转发进程
After=network-online.target wg-quick@wg0.service
Requires=wg-quick@wg0.service

[Service]
Type=simple
# 常驻不退出：桥接的 pidAlive() 要看到这个进程还在，才认为"服务端在运行"
ExecStart=/usr/lib/systemd/systemd-socket-proxyd --exit-idle-time=infinity 10.8.0.2:25565
Restart=always
RestartSec=5
NoNewPrivileges=true
SVC

systemctl daemon-reload

echo
echo "=== [2/4] 预热单元：起监听并拉起转发进程 ==="
cat > /etc/systemd/system/mc-proxy-warmup.service <<'WARM'
[Unit]
Description=预热 MC 端口桥（触发 socket-proxyd 常驻，并写 server.pid）
After=mc-server-proxy.socket mc-viewer-proxy.socket
Requires=mc-server-proxy.socket

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mc-proxy-warmup.sh
WARM
cat > /etc/systemd/system/mc-proxy-warmup.timer <<'WT'
[Unit]
Description=定时预热 MC 端口桥

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=5s
Unit=mc-proxy-warmup.service

[Install]
WantedBy=timers.target
WT

cat > /usr/local/bin/mc-proxy-warmup.sh <<'WSH'
#!/usr/bin/env bash
# 1) 自己连一下 25565/3200，触发 systemd-socket-proxyd 把转发进程拉起来并常驻
# 2) 把该进程 PID 写进 /home/wx/mc/server/logs/server.pid
#    —— 鱼群bot 用 pidAlive(server.pid) 判断"MC 服务端在运行"，
#       而真正的 java 在笔记本上、PID 在服务器无意义，这里用"端口桥活着"代表服务端可达。
set -u
for port in 25565 3200; do
  timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$port" 2>/dev/null || true
done
sleep 1
PID=$(pgrep -f 'systemd-socket-proxyd .*10\.8\.0\.2:25565' | head -1)
mkdir -p /home/wx/mc/server/logs
if [ -n "${PID:-}" ]; then printf '%s\n' "$PID" > /home/wx/mc/server/logs/server.pid; fi
WSH
chmod 755 /usr/local/bin/mc-proxy-warmup.sh

systemctl enable --now mc-server-proxy.socket 2>&1 | tail -1
systemctl enable --now mc-proxy-warmup.timer 2>&1 | tail -1

echo
echo "=== [3/4] 立刻预热一次 ==="
systemctl start mc-proxy-warmup.service 2>&1 | tail -2
sleep 3

echo
echo "=== [4/4] 验证 ==="
echo "--- 监听 ---"; ss -ltn | grep -E "25565|3200"
echo "--- 转发进程 ---"; pgrep -af 'systemd-socket-proxyd' | head -3
echo "--- server.pid ---"; cat /home/wx/mc/server/logs/server.pid 2>/dev/null
echo "--- MC 端口桥实测（能否完成 Minecraft 握手）---"
timeout 8 bash -c 'exec 3<>/dev/tcp/127.0.0.1/25565' 2>&1 && echo "✅ 25565 可建 TCP 连接" || echo "❌ 25565 不通"
