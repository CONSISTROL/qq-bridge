#!/usr/bin/env bash
# 彻底清理卡死的 apt/dpkg，并用最稳的参数装 NVIDIA 驱动
set -u
export DEBIAN_FRONTEND=noninteractive LC_ALL=C
export NEEDRESTART_MODE=l          # 关键：别让 needrestart 交互阻塞 dpkg
PW="$(cat /tmp/sudo.pw 2>/dev/null || echo '')"
S() { printf '%s\n' "$PW" | sudo -S -p '' "$@"; }

echo "########## 清锁 + 装驱动 $(date '+%F %T') ##########"

echo
echo "=== [1/5] 杀掉所有 apt/dpkg/needrestart 进程 ==="
S pkill -9 -f needrestart 2>/dev/null
S pkill -9 -f 'dpkg --' 2>/dev/null
S pkill -9 -f 'apt-get' 2>/dev/null
S pkill -9 -f 'unattended-upgrade' 2>/dev/null
sleep 3
echo "残留进程:"; ps -eo pid,cmd | grep -E "apt-get|dpkg|needrestart" | grep -v grep | head -5 || echo "  (无)"

echo
echo "=== [2/5] 清锁 ==="
S rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock 2>/dev/null
S dpkg --configure -a 2>&1 | tail -3
echo "dpkg 修复完成"

echo
echo "=== [3/5] 关掉 needrestart（避免再次挂起）==="
S sed -i 's/^#\?\$nrconf{restart}.*/$nrconf{restart} = '"'"'l'"'"';/' /etc/needrestart/needrestart.conf 2>/dev/null || true
grep -n "nrconf{restart}" /etc/needrestart/needrestart.conf 2>/dev/null | head -2 || echo "  (无 needrestart 配置)"

echo
echo "=== [4/5] 安装 nvidia-driver-580-open ==="
S env NEEDRESTART_MODE=l DEBIAN_FRONTEND=noninteractive \
  apt-get -o Acquire::ForceIPv4=true -o Dpkg::Use-Pty=0 install -y nvidia-driver-580-open 2>&1 | tail -10
echo "exit=$?"

echo
echo "=== [5/5] 校验 ==="
dpkg -l | grep -E "^ii +nvidia-driver-580" | awk '{print "已装:", $2, $3}'
ls /usr/lib/x86_64-linux-gnu/libnvidia-glcore.so* 2>/dev/null | head -2
echo "nvidia-smi: $(command -v nvidia-smi || echo '重启后才有')"
echo
echo "########## 完成 $(date '+%F %T') ##########"
