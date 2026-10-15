#!/bin/bash
# 启动 DSH Web（QQ 桥接会自动从 guard/logs 里发现 launch token）。
# 用法：bash /root/.dsh/guard/start-dsh.sh     —— 在 tmux 里跑也行，输出同时进日志。
# 为什么要有这个脚本：DSH 的 launch token 是进程内随机生成、不落盘的，只在启动横幅里打印一次，
# 而横幅要等插件树（含 MCP 子进程）settle 之后才出现（实测 ~97 秒）。桥接靠读 guard/logs 里
# 最新的 server-*.out.log 拿 token——所以启动时**必须把输出写进那个目录**，否则桥接会 401。
cd /home/wx/dsh || exit 1
export HOME=/root USER=root SHELL=/bin/bash LANG=en_US.UTF-8 TERM=tmux-256color
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
LOG="/root/.dsh/guard/logs/server-$(date +%Y%m%d-%H%M%S).out.log"
echo "[start-dsh] 日志：$LOG（token 会打印在里面，桥接自动读取）"
exec script -q -c "dsh web" "$LOG"
