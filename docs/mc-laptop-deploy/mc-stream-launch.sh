#!/usr/bin/env bash
# 推流渲染启动器（给 systemd 用）
# 从 stream-config.json 读画质参数 → 转成 MC_STREAM_* 环境变量 → exec render-stream.js
#
# 为什么不让 systemd 直接跑 render-stream.js：
#   画质参数存在 json 里（控制台可改），systemd 的 Environment= 是静态的，
#   这里做一层转换，改 json 后 systemctl restart mcstream 即可生效。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# IPv6 优先会让 npm/node 的网络调用卡住（本机 IPv6 不通），强制 IPv4
export NODE_OPTIONS="--dns-result-order=ipv4first"

# 读画质配置（缺项用内置默认值，与 stream.sh 保持一致）
eval "$(node -e '
  const fs = require("fs");
  const D = { w:640, h:360, rw:256, rh:144, fps:8, bitrate:"1000k", radius:28 };
  let c = {};
  try { c = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) {}
  const pick = (k) => (c[k] !== undefined && c[k] !== "" ? c[k] : D[k]);
  console.log(`export MC_STREAM_W=${pick("w")} MC_STREAM_H=${pick("h")} MC_STREAM_RW=${pick("rw")} MC_STREAM_RH=${pick("rh")} MC_STREAM_FPS=${pick("fps")} MC_STREAM_BITRATE=${pick("bitrate")} MC_STREAM_RADIUS=${pick("radius")}`);
' "$DIR/stream-config.json" 2>/dev/null || echo 'export MC_STREAM_W=640 MC_STREAM_H=360 MC_STREAM_RW=256 MC_STREAM_RH=144 MC_STREAM_FPS=8 MC_STREAM_BITRATE=1000k MC_STREAM_RADIUS=28')"

echo "[launcher] 画质 ${MC_STREAM_W}x${MC_STREAM_H}@${MC_STREAM_FPS}fps 投射 ${MC_STREAM_RW}x${MC_STREAM_RH} ${MC_STREAM_BITRATE} 半径 ${MC_STREAM_RADIUS}"
echo "[launcher] 推流目标: $([ -s "$DIR/stream.env" ] && echo 'stream.env 已就绪' || echo '❌ 缺 stream.env（需先开播）')"

exec /usr/bin/node "$DIR/render-stream.js" \
  --w "$MC_STREAM_W" --h "$MC_STREAM_H" \
  --rw "$MC_STREAM_RW" --rh "$MC_STREAM_RH" \
  --fps "$MC_STREAM_FPS" --bitrate "$MC_STREAM_BITRATE" \
  --radius "$MC_STREAM_RADIUS"
