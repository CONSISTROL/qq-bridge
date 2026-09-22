#!/usr/bin/env bash
# bili-fetch-run.sh — 定时从 B 站抓图入库
#
# 读 state/bili-targets.json（目标清单）与 state/bili-cookie.txt（可选 SESSDATA），
# 调用 scripts/fetch-bili-images.mjs，日志追加到 state/bili-fetch.log。
#
# 手动跑：  scripts/bili-fetch-run.sh
# 试运行：  scripts/bili-fetch-run.sh --dry-run
# 定时：    systemctl enable --now bili-fetch.timer
set -uo pipefail

ROOT="/home/wx/qq-bridge"
cd "$ROOT" || exit 1
TARGETS="$ROOT/state/bili-targets.json"
LOG="$ROOT/state/bili-fetch.log"
mkdir -p "$ROOT/state" "$ROOT/assets/stickers"

args=()
if [ -f "$TARGETS" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && args+=("$line")
  done < <(python3 - "$TARGETS" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
src = d.get('sources', {}) or {}
for b in d.get('bvids', []) or []:
    if src.get('cover', True):
        print('--bvid'); print(str(b)); print('--cover')
    if src.get('comments', True):
        print('--bvid'); print(str(b)); print('--comments')
for m in d.get('mids', []) or []:
    if src.get('dynamic', True):
        print('--mid'); print(str(m)); print('--dynamic')
for kw in d.get('keywords', []) or []:
    print('--keyword'); print(str(kw))
for c in d.get('cvs', []) or []:
    print('--cv'); print(str(c))
if src.get('detail', False):
    print('--detail')
for flag, key, default in [('--limit','limit',40), ('--dynamic-pages','dynamicPages',1),
                           ('--comment-pages','commentPages',1), ('--min-side','minSide',150),
                           ('--max-bytes','maxBytes',2097152), ('--delay','delayMs',900)]:
    print(flag); print(str(d.get(key, default)))
PY
  )
else
  echo "[bili-fetch] 缺少 $TARGETS，跳过。可复制 scripts/bili-targets.example.json 过去。" >> "$LOG"
  exit 0
fi

# 去掉重复的 --bvid（同一 BV 同时抓封面+评论时上面的生成会重复）
declare -a clean=()
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = "--bvid" ] && [ "${clean[*]:-}" = *"--bvid ${args[$((i+1))]}"* ]; then
    continue
  fi
  clean+=("${args[$i]}")
done

{
  echo "=== $(date '+%F %T') 开始抓图（cookie: $([ -f "$ROOT/state/bili-cookie.txt" ] && echo 有 || echo 无)） ==="
  node "$ROOT/scripts/fetch-bili-images.mjs" "${clean[@]}" "$@"
  echo "=== $(date '+%F %T') 结束 exit=$? ==="
} >> "$LOG" 2>&1
