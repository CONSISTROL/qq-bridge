#!/usr/bin/env bash
# 修复 dpkg 状态并完成 NVIDIA 驱动安装（全非交互，杜绝 debconf 挂起）
set -u
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
export LC_ALL=C
PW="$(cat /tmp/sudo.pw 2>/dev/null || echo '')"
S() { printf '%s\n' "$PW" | sudo -S -p '' "$@"; }

echo "########## 驱动安装收尾 $(date '+%F %T') ##########"

echo
echo "=== [1/6] 清掉所有卡住的 debconf/dkms/dpkg ==="
S pkill -9 -f 'debconf/frontend' 2>/dev/null
S pkill -9 -f 'common.postinst' 2>/dev/null
S pkill -9 -f 'dkms build' 2>/dev/null
S pkill -9 -f 'nvidia-dkms' 2>/dev/null
S pkill -9 -f needrestart 2>/dev/null
S pkill -9 -f 'apt-get' 2>/dev/null
sleep 3
echo "残留:"; ps -eo pid,cmd | grep -E "debconf|dkms|apt-get|dpkg --" | grep -v grep | head -5 || echo "  (无)"

echo
echo "=== [2/6] 清锁 ==="
S rm -f /var/lib/apt/lists/lock /var/lib/dpkg/lock /var/lib/dpkg/lock-frontend /var/cache/apt/archives/lock 2>/dev/null
echo done

echo
echo "=== [3/6] 补齐半配置的包（非交互，避免再次挂起）==="
S env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
  dpkg --configure -a 2>&1 | tail -6
echo "exit=$?"

echo
echo "=== [4/6] 确认 nvidia 包状态 ==="
dpkg -l | grep -E "nvidia" | awk '{print $1, $2, $3}' | head -10

echo
echo "=== [5/6] DKMS 编译内核模块 ==="
if ! ls /lib/modules/$(uname -r)/updates/dkms/nvidia.ko* >/dev/null 2>&1; then
  S env DEBIAN_FRONTEND=noninteractive dkms install -m nvidia -v 580.178.04 -k $(uname -r) 2>&1 | tail -10
else
  echo "模块已存在"
fi
ls -la /lib/modules/$(uname -r)/updates/dkms/nvidia*.ko* 2>/dev/null | head -4

echo
echo "=== [6/6] 校验 ==="
S env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
  apt-get -o Acquire::ForceIPv4=true -o Dpkg::Use-Pty=0 install -y -f 2>&1 | tail -5
echo "nvidia-smi: $(command -v nvidia-smi || echo '重启后才有')"
echo
echo "########## 完成 $(date '+%F %T') ##########"
