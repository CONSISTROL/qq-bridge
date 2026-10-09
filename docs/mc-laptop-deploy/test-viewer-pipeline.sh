#!/usr/bin/env bash
# 端到端验证：抓 :99 的真实 viewer 画面 → x264 → 本地 RTMP 接收端
set -u
export LC_ALL=C
echo "########## viewer 管线端到端 $(date '+%F %T') ##########"

pkill -f 'ffmpeg.*1938' 2>/dev/null
rm -f /tmp/viewer-test.flv
setsid nohup ffmpeg -loglevel warning -listen 1 -f flv -i rtmp://127.0.0.1:1938/live/v \
  -c copy -y /tmp/viewer-test.flv > /tmp/vrecv.log 2>&1 < /dev/null &
sleep 3
echo "接收端已起"

rm -f /tmp/vpush.log
DISPLAY=:99 timeout 60 ffmpeg -hide_banner -loglevel info \
  -f x11grab -framerate 30 -video_size 1920x1080 -i :99 \
  -t 25 -c:v libx264 -preset ultrafast -tune zerolatency \
  -b:v 6000k -maxrate 6000k -bufsize 9000k -g 60 -pix_fmt yuv420p \
  -f flv rtmp://127.0.0.1:1938/live/v > /tmp/vpush.log 2>&1
echo "推流退出码=$?"
echo "--- 推流统计（最后一帧）---"
tail -c 400 /tmp/vpush.log | tr '\r' '\n' | grep -E "frame=" | tail -1

sleep 2
pkill -f 'ffmpeg.*1938' 2>/dev/null
sleep 1
echo
echo "--- 接收端校验 ---"
if [ -s /tmp/viewer-test.flv ]; then
  ls -la /tmp/viewer-test.flv | awk '{printf "收到 %.2f MB\n", $5/1048576}'
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,r_frame_rate,codec_name \
    -show_entries format=duration -of default=noprint_wrappers=1 /tmp/viewer-test.flv 2>&1 | head -6
else
  echo "❌ 接收端无数据"; tail -5 /tmp/vrecv.log
fi
echo "########## 完成 $(date '+%F %T') ##########"
