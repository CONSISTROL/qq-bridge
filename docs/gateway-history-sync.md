# 网关登录历史同步（SnowLuma）— 2026-11-18 记

## 背景
11-15 16:06 QQ 登录态失效（身份验证失败 x20），OneBot session 关闭，
桥接 WS 断开 → bot 离线约 74 小时。恢复后问"这 4 天的群消息能不能补回来"。

## 结论
- `get_group_msg_history` 只返回网关"收到过"的消息，离线期间没有 → 单靠它补不回来。
- 网关有 `historySync` 开关（`/app/data/config/onebot_2840404638.json` → `historySync.enabled`），
  打开后会向服务器拉"登录历史"，把漏掉的消息补进本地 message store，
  之后 `get_group_msg_history` 就能取到 → 桥接补拉 → 归档 → 记忆。
- 但原版在 probe 阶段一处失败就整体中止：
  `login history sync failed: probe group 635109092 response identity does not match the request`。

## 已做的补丁（容器内 /app/runtime/index.mjs）
把 `probeHistorySyncState` 里 groups 的 map 包了 try/catch：
失败的群记一条 warn 并跳过（返回 null 后 filter 掉），其余群照常同步。
备份：`/app/runtime/index.mjs.bak-<ts>`。
⚠️ 容器升级/重建会丢掉这个补丁，需要重打。

## 效果
- 每次 runtime 重启触发一轮同步，逐轮推进（实测 20 → 13 → …），
  store 覆盖从 11-15 07:59 推进到 11-18 18:08。
- 缺口期实际归档到的消息：群 1050666134 共 33 条、私聊 3 条（不是全部，QQ 侧只给增量窗口）。
- 桥接侧同时修了两点：
  1. 补拉到的消息**写入归档**（之前只进 recentMessages，记忆里查不到）；
  2. 补拉改为每 12 分钟一次（原来只在重连时跑一次）。

## 运维
- 想再补一批：`docker exec snowluma supervisorctl restart snowluma`，等 ~40 秒，
  然后 `node scripts/archive-recent-missing.mjs`（补归档）→ 重建记忆索引。
- 重建索引需要显存：`systemctl stop rvc-webui` → 重建 → `systemctl start rvc-webui`。
