# 网关登录历史同步（SnowLuma）— 2026-11-18 记

## 背景
11-15 16:06 QQ 登录态失效（身份验证失败 x20），OneBot session 关闭，桥接 WS 断开，
bot 离线约 74 小时。恢复后要"把没登录期间的聊天记录同步进记忆"。

## 结论（关键）
1. `get_group_msg_history` 只返回网关"收到过的"消息，且固定 200 条、不支持翻页 → 单靠它补不回。
2. 网关有 `historySync` 开关（`/app/data/config/onebot_2840404638.json` → `historySync.enabled`），
   打开后登录时会向服务器拉历史并写入自己的 `messages.db`。
   但原版 probe 一处失败就整体中止（`probe group 635109092 response identity does not match the request`），
   且限制为「每次最多 3 个会话 × 每会话 20 条」。
3. **最终可靠做法：直接读网关的 messages.db**（`/app/data/data/2840404638/messages.db`，1.4G，明文 SQLite），
   按时间窗导出消息再导入桥接归档——不受同步批次限制，也不依赖 cursor。

## 已打的补丁（容器内 /app/runtime/index.mjs）
- `probeHistorySyncState`：单个群 probe 失败改为 warn + 跳过（返回 null 后 filter），不再中止整轮；
- `LOGIN_HISTORY_SYNC_LIMITS`：maxMessagesPerSession 20→300、maxGroups 3→50、maxPrivateUsers 3→50。
备份：`/app/runtime/index.mjs.bak-<ts>`。⚠️ 容器升级会丢，需要重打。

## 本次恢复结果（缺口 11-15 15:08 → 11-18 18:08）
- 网关 messages.db 里该窗口实际消息：群 1050666134 = 46 条、群 217423624 = 2 条、私聊 = 4 条；
- 导出并导入归档：group:1050666134 39 条（其余为自身消息/空消息）、private 4 条；
- 逐 id 核对：**归档缺失 0 条**（缺口期记录已全部同步）；
- 索引重建 457 条；抽查「flandre 上一把」召回重排 0.863，命中的正是缺口期对话。

## 以后怎么补（可复用脚本）
```bash
cd /home/wx/qq-bridge
LO=$(node -e "console.log(Math.floor(new Date('2026-11-15T15:08:00+08:00').getTime()/1000))")
HI=$(node -e "console.log(Math.floor(Date.now()/1000))")
docker cp scripts/gateway-db-export.py snowluma:/tmp/gateway-db-export.py
docker exec snowluma python3 /tmp/gateway-db-export.py $LO $HI > /tmp/gap.jsonl
node scripts/import-gateway-messages.mjs /tmp/gap.jsonl
# 然后重建记忆索引（需先腾显存：systemctl stop rvc-webui → 重建 → start）
```

## 附带修复
- bridge：补拉到的消息现在会写入归档（之前只进 recentMessages，记忆里查不到）；
- bridge：补拉从"仅重连时一次"改为每 12 分钟一次；旧消息（>5 分钟）只入库、不唤醒。
