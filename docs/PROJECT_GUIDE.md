# DSH QQ 桥接（qq-bridge）项目说明书

> 让 DeepSeek Harness（DSH）的 agent 以“仿真群友”身份接入 QQ 群/私聊。
> 本文是面向公开仓库的精简版说明；本地开发历史、个人配置与运行状态不会包含在仓库中。

---

## 1. 项目是什么

`qq-bridge` 是一个独立的 Node.js 进程，做三件事：

1. **连接 QQ**：通过 SnowLuma（OneBot v11 WebSocket）收发 QQ 群/私聊消息。
2. **连接 DSH**：通过 DSH Web API（默认 `127.0.0.1:3080`）创建会话、投递 prompt、接收事件流。
3. **扮演群友**：在仿真模式下，用“观望/活跃/试探/退场”状态机决定何时说话、何时沉默、怎么分多条消息发，并注入人格角色（如小鲸鱼）。

它不是简单的“QQ 消息转发器”，而是一个带**社交策略层**的桥。

---

## 2. 架构总览

```
┌─────────────┐   OneBot WS   ┌──────────────────────┐   HTTP/WS   ┌──────────────────┐
│  SnowLuma   │◄─────────────►│      qq-bridge       │◄───────────►│   DSH Harness    │
│  (QQ 网关)  │               │   src/bridge.js      │             │  (agent 会话)    │
└─────────────┘               │   src/dsh-client.js  │             └──────────────────┘
                              │   src/mcp-*.js       │
                              └──────────────────────┘
                                      │ 控制台
                                      ▼
                              public/console/ (127.0.0.1:3100)
```

| 层 | 文件 | 职责 |
|---|---|---|
| 内核 | `src/bridge.js` | 主程序：QQ 消息接入、社交状态机、DSH 投递、发送链、安全审计（控制台路由见 `src/console/`） |
| 内核 | `src/config.js` | 配置加载与默认值/规范化（从 bridge 抽出，可单独阅读） |
| 内核 | `src/json-store.js` | JSON/文本文件的安全读写（BOM 容错 + 原子写；各模块共用） |
| 内核 | `src/console/*.js` | 控制台 HTTP 路由：按领域拆成 mc / core / slang-knowledge / social / media / agent 六个模块，依赖由工厂函数注入 |
| 内核 | `src/dsh-client.js` | DSH 协议客户端：RPC + WebSocket 事件流 + turn 收集 |
| 内核 | `src/mcp-snowluma-safe.js` | 给 DSH agent 用的安全 QQ 工具（只读 + 白名单发送） |
| 内核 | `src/mcp-host-server.js` | 给 DSH agent 用的 SnowLuma 进程管理（默认禁用启停） |
| 内核 | `src/slang-learner.js` | 群聊黑话/网络用语学习：存储、候选提取、研究调度、注入 |
| 内核 | `src/knowledge-store.js` | 群知识库（问题→答案）：指纹去重、命中计数、注入渲染、落盘 |
| 内核 | `src/mcp-web-search-safe.js` | 给 DSH agent 用的只读 Web Search MCP（查网络用语/梗） |
| 外核 | `public/console/` | 本地控制台（左侧导航 + hash 路由分区）：外壳 `index.html` + `style.css` + `core/`（api / dom / router / poll / status / fragments / theme）+ `views/*.js|html`（每分区一对，markup 与逻辑同处）；**默认浅色，左下角可切深色**（`scripts/test-console-theme.mjs` 守护） |
| 外核 | `config.json` | 运行配置（白名单、QQ/DSH 地址、社交参数）；**不入库** |
| 外核 | `roles/*.md` | 人格卡（如 `小鲸鱼.md`） |
| 外核 | `state/*` | 运行时状态（会话映射、模式、日志）；**不入库** |
| 外核 | `start.bat` / `restart.bat` | 守护启动 / 一键重启 |
| 外核 | `scripts/*` | 测试/辅助脚本 |

### 3.1 控制台路由（`src/console/`）

控制台 HTTP 路由按领域拆成六个模块，每个模块导出 `createXxxRoutes(deps)`，返回一组
`handleXxxRoutes(routeCtx)`：

- **依赖注入**：`bridge.js` 在 `main()` 里创建 handler。稳定的函数/常量按值传入；
  会被重新赋值的绑定（`cfg` 以外的 `let`，如 `slangEntries`）用 getter/setter，
  模块内以 `deps.xxx` 访问，改的是同一份内存。
- **请求上下文**：`routeCtx` 提供 `req / res / url / sendJson / readBody`，以及控制台作用域里的
  `v2ToolEnabled`、`consoleCookieHeader` 等。
- **分发**：`startConsoleServer` 按数组顺序调用 handler，命中并响应后 `res.writableEnded === true`，
  后面的组不再执行。**新增路由**：在对应模块里加分支，再把 handler 名加进 `consoleRouteHandlers`。

### 3.2 控制台视觉规范（`public/console/style.css`）

控制台的视觉样式只有一个来源：`public/console/style.css`。改样式前先看这几条，避免又回到
「每个页面各写一套内联样式」：

- **颜色只写在两个主题变量块里**（`:root` / `:root[data-theme="dark"]`），规则里一律用
  `var(--x)`。`scripts/test-console-theme.mjs` 会检查两套变量集合完全一致、规则里没有写死色值。
- **页面标题由外壳统一渲染**：`views/<id>.js` 导出 `title` / `desc` / `icon`，`app.js` 写进顶栏；
  片段里不要再写一份 `<h2>`（会重复）。`icon` 必须是 `core/icons.js` 注册表里的名字。
- **图标统一用 SVG**：导航、页头、状态、提示都用 `core/icons.js` 的线性图标（24×24、1.7px 线宽、
  `currentColor`），不要再往界面里放 emoji（不同系统字体下大小/颜色不可控）。
- **优先用共享组件**：`.card`、`.btn`（`primary` / `danger` / `danger-ghost` / `small`）、
  `.toolbar`、`.tabs` + `.tab`、`.pill`、`.msg`、`.empty`、`.modal`、`.form-row` / `.form-grid`。
  需要新样式时加在 `style.css`，不要往 `.html` 片段里塞 `<style>`。
- **布局断点**：1100px（侧栏收窄）、900px（侧栏隐藏，换成底部四个常用分区 + 「更多」抽屉）、
  640px（表单/卡片单列、输入框 16px、弹窗改成底部 sheet）。列表页优先用 `.grid` /
  `.grid.cols-2` / `.toolbar`，不要在行内写 `margin`、`gap`。
- **手机安全区**：`viewport-fit=cover` + `env(safe-area-inset-*)`，底栏和弹窗都留出 iPhone/小米全面屏底部空间。

---

## 3. 目录结构（公开仓库）

```
qq-bridge/
├── src/
│   ├── bridge.js               # 主程序（启动、消息流、调度；控制台路由已拆到 console/）
│   ├── config.js               # 配置加载与默认值/规范化
│   ├── json-store.js           # JSON/文本安全读写（BOM 容错 + 原子写）
│   ├── console/                # 控制台 HTTP 路由（按领域拆分，工厂注入依赖）
│   │   ├── mc-routes.js        #   MC 状态/推流/服务控制/白名单
│   │   ├── core-routes.js      #   首页/角色/会话/白名单/安全/令牌/重启
│   │   ├── slang-knowledge-routes.js  # 黑话库 + 群知识库
│   │   ├── social-routes.js    #   聊天模式（配置/唤醒/发送/资料/探索/工作车道）
│   │   ├── media-routes.js     #   表情/搜图/B站/相册/AI 图片/图片查询
│   │   └── agent-routes.js     #   转发/备注/记忆/插件/语音/手机/豆包
│   ├── dsh-client.js           # DSH API 客户端
│   ├── mcp-snowluma-safe.js    # 安全 MCP（QQ 读/发工具）
│   ├── mcp-host-server.js      # MCP（SnowLuma 进程管理，默认禁用启停）
│   ├── mcp-web-search-safe.js  # 安全 MCP（只读 Web Search/Fetch）
│   ├── slang-learner.js        # 黑话/网络用语学习模块
│   ├── knowledge-store.js      # 群知识库（问题→答案，复用黑话的向量检索链路）
│   ├── member-remarks.js       # 群成员备注库（AI 私有记忆，纯函数）
│   ├── memory-admin.js         # AI 记忆管理（统一清单/增删/钉住/自然遗忘/备份回滚）
│   ├── image-admin.js          # AI 图片管理（本机图片清单/删除/自然清理/回收站还原）
│   ├── sent-images.js          # AI 发出去的网络图落盘（发送历史，供控制台回看/管理）
│   ├── content-filter.js       # 入站内容策略（越线请求不进模型，纯函数）
│   ├── image-allow.js          # 图片来源白名单 / Referer 判定（纯函数）
│   ├── card-parse.js           # QQ 卡片消息（json/xml/share）解析（纯函数）
│   ├── html-text.js            # HTML 正文/元信息抽取 + SPA 识别（纯函数）
│   ├── browser-render.js       # 无头浏览器渲染（内存优先设计）
│   ├── safe-proxy.js           # 无头浏览器的出网过滤代理（网络层 SSRF 边界）
│   ├── md-to-plain.js          # Markdown 转纯文本
│   ├── safe-fetch.js           # SSRF 防护的 HTTP(S) 抓取
│   └── self-test.js            # DSH 侧自检
├── public/
│   └── console/                # 控制台前端（无构建，原生 ES module）
│       ├── index.html          # 外壳：侧边导航 + 视图容器 + 防闪烁内联主题脚本
│       ├── style.css           # 样式（浅/深两套变量；含布局与吐司提示）
│       ├── app.js              # 入口：注册分区 → 建导航 → 起路由与状态轮询
│       ├── core/               # api / dom / routing / poll / status / fragments / theme / icons（SVG 图标）
│       └── views/              # 每分区一对：xxx.js（逻辑）+ xxx.html（markup）
│           ├── overview.*      # 01 运行模式 + 02 会话 + 03 挂起 + 04 日志
│           ├── social1.*       # 06 一代仿真模式
│           ├── social2.*       # 07 二代仿真模式（含工具级配置弹窗）
│           ├── slang.*         # 08 黑话库 + 08b 本地向量检索
│           ├── knowledge.*     # 09 群知识库（问题→答案）+ 检索调试
│           ├── memory.*        # 10 AI 记忆 （七类记忆的清单/增删/钉住/备份回滚）
│           ├── images.*        # 11 AI 图片 （本机图片的清单/删除/自然清理/回收站）
│           ├── persona.*       # 05 人格 + 11 静默开关
│           ├── security.*      # 10 白名单 + 12 安全通知 + 12b 控制台令牌
│           ├── ops.*           # 13 测试发送 + 14 桥接控制
│           └── tools.*         # 09 MCP 工具清单 + 15 后台控制端引导
├── roles/
│   ├── 小鲸鱼.md               # 当前人格卡
│   ├── 傲娇助手.md
│   └── README.md
├── docs/
│   ├── PROJECT_GUIDE.md        # 本文档（公开版）
│   └── DSH_SETUP.md            # DSH 端安装说明（另一台设备）
├── dsh/
│   └── agent-presets/          # qq-chat / qq-chat-v2 的 DSH preset 模板
├── plugins/
│   └── qq-mode-console/        # DSH 插件：注册 qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
├── assets/
│   └── deepseek娘.png          # AI 自我形象图（qq_get_self_image）
│                               # 项目介绍视频不进仓库，改由 Release 附件托管（README 有链接）
├── scripts/                    # 通用测试/辅助脚本（含 setup-dsh.mjs）
├── config.example.json         # 配置模板（占位符，不含真实凭据）
├── package.json
├── README.md
└── README.en.md
```

> `config.json`、`state/`、`node_modules/`、本地开发/计划/调研文档以及一次性本地脚本均不在公开仓库中。

---

## 4. 核心数据流

### 4.1 一条 QQ 消息的完整旅程

```
QQ 消息
  │
  ▼
bot.onGroupMessage / onPrivateMessage (bridge.js)
  │
  ▼
handleIncoming(kind, id, event)
  ├─ 白名单/模式检查（modeAllowed / allowed）
  ├─ 管理命令拦截（/reset /role /silent 等，仅 owner）
  ├─ 挂起审批/提问优先处理（pending）
  ├─ 社交模式分支（仿真模式）：
  │     ├─ 观望期：按触发条件决定是否进活跃
  │     ├─ 活跃期：私聊即时投递；群聊等轮询批量检测
  │     └─ 冷场/试探
  └─ 非社交模式：直接投递给 DSH
  │
  ▼
ensureSession(key)  →  DSH session（工作区“QQ 聊天”）
  │
  ▼
api.sessions.prompt({ mode: 'queue' })
  │
  ▼
DSH 事件流（api.events.mux → /api/remote.mux + session/follow + $events）→ pumpMux()
  ├─ turn collector 收集模型输出
  ├─ 安全审计（SENSITIVE_RE）
  ├─ 社交模式：planSocialTimeline 分条 → sendBurstToQQ
  └─ 非社交模式：sendToQQ 直接发
```

- 群聊里的 `@` 段会解析成群名片/昵称（带缓存），解析失败时回退为 QQ 号。
- 引用/回复段会解析成被引用人的群名片/昵称 + 原文，注入 prompt。
- 一代仿真模式（`reserved`）下，模型可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送。
- 一代仿真模式（`reserved`）的分条方式为“按空格分句”：AI 用空格表示下一条消息，桥接按空格拆条；`reserved2` 不适用，分条请用 `qq_send_message` 数组。

### 4.2 DSH 事件流 / turn 收集

- `dsh-client.js` 通过 `/api/remote.mux` WebSocket 保持长连接；对每个需要接收的会话显式 `session/follow`，并自动打开 `$events` 流接收提问/审批等 Remote Event。
- `createTurnCollector` 按 `assistant/message` 累加文本，`turn/end` 时产出完整结果。
- 摘要投喂会产生“静默 turn”：结果不发给 QQ，只作为记忆。

### 4.3 黑话学习 / 网络用语迭代

```
群聊消息 → bridge 滚动窗口（slangWindows）
  → 攒够 extractMinMessages 条 → DSH 学习会话提取候选
  → 写入 state/slang.json（candidate，count+1，保留证据）
  → 达到 inferenceThresholds 时 → DSH 学习会话联网搜索确认
  → 生成 meaning/usage/example → 仍为 candidate
  → 控制台「黑话管理」人工确认/拒绝
  → confirmed 词条 → 注入 QQ agent 的【群聊黑话表】
```

- 学习会话与 QQ 会话隔离：学习输出不会发 QQ。
- 只有人工确认的词条才会进入聊天上下文。
- **控制台手动添加也落 candidate**（`POST /api/slang` 不传 `status` 时默认候选，非法 `status` 同样落候选）：
  已确认的词条会被注入提示词、被 AI 当成事实使用，所以「刚敲进去、还没复核」的词不该直接生效。
  添加后控制台会自动切到「候选」标签页，确认（或批量确认）后才进【群聊黑话表】。
  只有显式传 `status: "confirmed"` 才会直接入库为已确认（例如从别处导入一批已核实的词）。

---

## 5. 内核详解

### 5.1 bridge.js（主程序）

| 模块 | 说明 |
|---|---|
| `loadConfig` | 读取 `config.json`，fail-fast；提供社交参数默认值 |
| `allowed` / `modeAllowed` | 白名单 + 模式准入（closed-agent 仅 owner 私聊） |
| `acquireLock` / `releaseLock` | 单实例锁（原子 `fs.openSync('wx')` + stale 检测） |
| `ensureSession` | 创建/复用 DSH 会话，带 `sessionEpoch` 防止 reset 竞态 |
| `social` | 社交引擎状态（states / recentMessages / pendingSummaries / silentContext / silentTurns / pendingTimers） |
| `socialLoopTick` | 每 5 秒扫描状态机：主动开话题、活跃检测、冷场、试探 |
| `buildBatchPrompt` | 活跃期投递文本（只贴新消息 + 之前沉默的消息） |
| `planSocialTimeline` | 按空格分句拆条（AI 用空格控制；单条 500 字安全上限） |
| `sendBurstToQQ` | 分条发送：随机间隔/长间隔，最后一条不 sleep |
| `pumpMux` | DSH 事件流消费：收集、审计、发送 |
| `startConsoleServer` | 本地控制台 HTTP 服务 + API |
| `flushSummaries` | 观望期未参与消息 → 摘要投喂（静默 turn） |

### 5.2 社交状态机

```
        观望 idle
        │   ▲
  触发进活跃 │   │ 冷场/试探无回应 / 退场完成
        ▼   │
       active ──冷场──► probing
        │                │
        └──新消息────────┘
        │
        └──活跃超时──► exiting ──退场发言完成──► idle
```

- **观望**：只记录消息到 `recentMessages` 和 `pendingSummaries`；触发条件包括被 @/关键词/提问、普通消息小概率、群长期静默后小概率主动开话题。
- **活跃**：每 `activeCheckMinMs~MaxMs` 检测一次新消息；私聊即时投递，群聊按批量检测。
- **退场（exiting）**：活跃超时后的过渡状态，等待 AI 的收尾发言发出。
- **冷场**：`idleWindowMs` 内无新消息 → 大概率回观望，小概率进试探。
- **试探**：AI 主动说一句，`idleRetryWaitMs` 内无人回应则回观望。

### 5.3 分条发送 / 错落感

`planSocialTimeline(text, cfg)` 返回 `{ main: string[], followUp: null }`：

1. 分句权交给 AI：AI 用空格表示“这里要分成下一条消息”。
2. 不想分条就不用空格。
3. 空格两侧只要有一侧是中文，就会被当作分条信号。
4. 单条消息只做 `maxReplyChars`（默认 500 字）安全硬拆。
5. `sendBurstToQQ` 按随机间隔发送，有概率用长间隔；最后一条后不 sleep。

### 5.4 MCP 工具

`mcp-snowluma-safe.js` 给 DSH agent 暴露：

| 工具 | 说明 | 白名单 |
|---|---|---|
| `qq_status` | 登录状态 | 无 |
| `qq_list_groups` | 群列表 | 只返回白名单群 |
| `qq_get_group_members` | 群成员；返回 QQ 群真实身份 `role`（owner=群主 / admin=群管理员 / member=成员），并在开头单列「本群群主」 | 群号必须白名单 |
| `qq_get_group_history` | 群历史 | 群号必须白名单 |
| `qq_send_group_message` | 发群消息；可选 `replyToMessageId` | allow+deny+allowAllWhenEmpty，纯文本段防 CQ 码 |
| `qq_reply` | 专用“引用/回复”工具 | 同上 |
| `qq_send_private_message` | 发私聊；可选 `replyToMessageId` | 同上 |

二代仿真模式（`reserved2`）还有：

- 状态/消息：`qq_get_prompt`、`qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_message_detail`、`qq_get_active_members`、`qq_social_state`
- 看图/看视频：`qq_get_message_images`（图片/表情）、`qq_get_message_video`（聊天里的 QQ 视频，抽帧；需本机 ffmpeg，无语音转写）
- 发送/互动：`qq_send_message`、`qq_send_burst`、`qq_send_poke`、`qq_send_sticker`
- 等待/收尾：`qq_wait_for_messages`、`qq_mark_read`、`qq_set_wake_config`
- 记忆/黑话/知识库/表情：`qq_memory_*`、`qq_slang_query`、`qq_slang_submit`、`qq_knowledge_query`、`qq_knowledge_submit`、`qq_list_stickers`、`qq_get_sticker_image`、`qq_sticker_note`、`qq_collect_sticker`
- 群成员备注：`qq_get_member_remarks`、`qq_set_member_remark`、`qq_remove_member_remark`（本地私有记忆，见 §5.5）
- 形象：`qq_get_self_image`

`mcp-web-search-safe.js` 另有（给所有模式用）：`web_search`、`web_fetch`、`web_render`（无头浏览器，读 SPA）。

`mcp-host-server.js`：

- `snowluma_status`：只读探活。
- `start_snowluma` / `stop_snowluma`：默认禁用，需 `config.json` 设置 `snowluma.allowProcessControl: true`，且仅在 `closed-agent` 模式下可用。

`mcp-web-search-safe.js`：

- `web_search(query)`：只读搜索。
- `web_fetch(url)`：只读抓取 HTTP(S) 网页正文，带内网/本机地址 SSRF 拦截。

### 5.5 群成员备注（AI 私有记忆）

先明确一件事：**SnowLuma/OneBot 没有「群成员本地备注」接口**。查遍网关的 178 个 action，
和「备注/名片」相关的只有三个，都不是「只给自己看的成员备注」：

| action | 实际语义 | 为什么不适合当记忆 |
|---|---|---|
| `set_group_remark` | 改**群**备注（自己视角的群名） | 对象是群，不是成员 |
| `set_friend_remark` | 好友备注 | 只对已是好友的人生效；群聊里显示的还是群名片/昵称 |
| `set_group_card` | 群名片 | 需要机器人是管理员/群主，且**全群可见** |

所以「AI 自己记住谁是谁」这件事由桥接本地承担：

- 存储：`state/member-remarks.json`，按 `会话 key`（`group:群号` / `private:QQ号`）+ **QQ 号** 索引；
  昵称/群名片只作为「记录当时的快照」，群友改昵称不会丢备注。
- 读写：`qq_get_member_remarks`（可传 `q` 按 QQ 号/备注/昵称/说明模糊搜）、
  `qq_set_member_remark`（`remark` 短名 ≤20 字、`note` 说明 ≤200 字，只传一个则另一个保留原值）、
  `qq_remove_member_remark`。
- **默认不注入提示词**：备注不占 token，AI 想认人时自己来查（`qq_get_prompt` 的 `enabledTools` 里能看到工具名）。
- 独立于 `social-v2.json`：`/reset`、切模式、清会话状态都不会丢备注。
- 控制台「二代仿真 → 轻量记忆」面板里能看/改/删，方便管理员自己维护。

另外提供 `qq_set_member_card`（真·QQ 群名片，走 `set_group_card`）：**默认关闭**，
必须 `socialV2.tools.setMemberCard=true` 才会注册，且同一人 15 秒冷却。它适合「正名」，不该拿来当记忆。
控制台的「全部开启」按钮**不会**顺手打开它——这类默认关闭的高危工具只能一个个手动开。

### 5.6 AI 记忆管理（控制台「AI 记忆」分区）

AI 的记忆**不是一个文件**，而是七类东西拼起来的。它们各自的写入方、存放位置与「AI 什么时候会看到」都不一样：

| # | 记忆 | 存放 | 谁写 | AI 什么时候看到 | 条数上限 |
|---|---|---|---|---|---|
| 1 | 进行中的话题 / 想说没说的话 / 对群友的印象 | `state/social-v2.json` 的 `activeTopics` / `pendingThoughts` / `memberImpressions` | AI（`qq_memory_append`） | **每次唤醒都注入提示词**（`formatMemoryV2`） | 各 20 / 20 / 名字数不限 |
| 2 | 群成员备注（谁是谁） | `state/member-remarks.json` | AI（`qq_set_member_remark`）或控制台 | 不注入；AI 想认人时自己 `qq_get_member_remarks` 查 | 单会话 300 人 |
| 3 | 对话上下文与原始转录 | `state/social-v2.json` 的 `recentMessages`/`unread` + `~/.dsh/sessions/<工作区>/<会话 id>/` | 桥接 / DSH | 唤醒时按需给 AI 看；转录由 DSH 自己管理 | recent 200 / unread 100 |
| 4 | 黑话库（词 → 含义） | `state/slang.json` + `state/slang-vectors.json` | DSH 提取 + AI 提交 + 控制台确认 | 确认过的进提示词/语义检索 | — |
| 5 | 群知识库（问题 → 答案） | `state/knowledge.json` + `state/knowledge-vectors.json` | AI（`qq_knowledge_submit`） | 有人问到相似问题时检索注入 | — |
| 6 | 收藏表情与其含义笔记 | `state/stickers.json`（表情本身在 QQ 账号上） | AI（`qq_sticker_note`） | 选表情时参考 | — |
| 7 | 长期记忆文件（`~/.dsh/AGENTS.md` 等） | DSH 工作区 | AI 自己 | DSH 每轮都读 | — |

**第 7 类桥接不代管**（没有权限也不该替 AI 改），控制台只登记它的位置、行数与体积——想改请去 DSH 工作区。

管理入口是控制台左侧「AI 记忆」分区（`🧷`），对应 `src/memory-admin.js` + `/api/memory*`（**只允许控制台**：
带 `x-agent-token` 的请求一律 403，AI 自己的记忆工具走 `/api/socialV2/memory-*`）。它能做的事：

- **清单**：七类记忆各有多少条、约吃多少 token；区分「每次唤醒注入 / 语义检索注入 / AI 主动查」，页面上还有「下次唤醒时 AI 会看到什么」的原文预览（和真正拼提示词是同一段代码 `formatMemoryV2`）。
- **逐条查 / 改 / 删**：按类型 + 会话 + 关键词过滤；行内「忘掉」删单条，「忘掉选中」批量删，「清空这一类 / 清空该会话全部记忆」整片清。**逐条删除不受钉住保护**（那是你点名要删的那一条），批量清空/清空一整类默认跳过钉住的，只有勾上「清空时连钉住的一起」才会带上。
- **钉住（pin）**：写进 `state/memory-pins.json`，之后所有「清空 / 自然遗忘」都跳过它——钉住是安全承诺，所以话题/想法的钉子用**稳定 pinId（数组下标）**而不是会改写的原文；条目本身没了的时候钉子自动摘除。
- **自然遗忘**：按规则清理「本来就该自己消失」的东西——过期想法（默认 2h）、搁置话题（默认 24h）、长期没用过的表情笔记（默认 90 天），阈值可在页面上改。钉住的一律跳过；黑话库/知识库不会被它误伤。
- **备份 / 回滚**：任何清空或遗忘之前自动打一份快照（`state/backups/memory-YYYYMMDD-HHMMSS/`，最多留 30 份，含 `social-v2.json` / `member-remarks.json` / `slang.json` / `knowledge.json` / `stickers.json`）；也可以随时手动「立即备份」。回滚会先给「当前状态」再打一份，所以回滚本身也可回滚；回滚前逐份校验 JSON，坏备份整份拒绝、绝不半途覆盖。`forget-user.sh` 建的备份同样会列在这里（标为「外部备份」）。
- **API**：`GET /api/memory`、`GET /api/memory/items`、`GET /api/memory/preview`、`GET /api/memory/backups`、`POST /api/memory/{pin,remove,clear,forget,backup,restore}`。
- **自检**：`npm run test:memory`（纯函数层，临时目录）与 `npm run test:memory:e2e`（起一个隔离桥接打真实 HTTP）。

「要清干净某个人的全部痕迹」仍然用 `forget-user.sh`（它多做了会话解绑、DSH 转录删除、归档这些桥接之外的事）；
控制台的这个分区负责的是「AI 记住了什么、逐条怎么改、怎么防手滑」。

### 5.7 入站内容策略（越线请求不让 AI 思考）

`src/content-filter.js` + `config.json` 的 `moderation` 段。**在消息进队列之前**判定：
命中就由桥接自己回一句固定短话（或静默），消息**不进未读、不触发唤醒、不写进会话上下文**——
模型连"发生过这件事"都不知道，也就不会有「思考 → 生成拒绝 → 对方还是没收到」那一串浪费。

为什么需要它（真实事故）：有人在私聊里反复发同一类越线请求，模型每轮都完整思考一遍、
生成一句拒绝，然后因为 reserved2 的文本不自动转发而一个字都没发出去，对方以为它不理人。
所以这一层管的是"它要不要为这件事花一次推理"——拦的是**管理员显式点名的那几种请求**，
不是"AI 自己觉得敏感的话题"。

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `action` | `reply` | `reply` = 回一句固定话；`silent` = 完全不回（连提示都没有） |
| `replyText` | `这个我不接，换一个吧` | `action=reply` 时由**桥接**发出去的原文（不经过模型） |
| `matching` | `substring` | `substring` = 包含即命中；`regex` = 整串按正则（写错的正则会被跳过，不会误杀） |
| `patterns` | `[]`（空） | 词/正则表；**显式传空数组 = 不拦**，不传 = 用默认表（默认表也是空的） |
| `extraPatterns` | `[]` | 追加词（要单独收紧的群/话题写这里） |
| `logMatch` | `false` | 是否把命中的原话写进活动日志（默认只记命中词，不落原话） |
| `cooldownMs` | `0` | 同一会话同一规则命中后的固定回复冷却（防刷屏） |

默认词表**是空的**：只有管理员显式写进来的词才拦。判定是字面级的，不追求语义理解——宁可漏杀，也不误杀正常聊天。

**ACG 体裁/标签词绝不能进默认词表**（2026-09 定）：`萝莉` / `合法萝莉` / `ロリ` / `loli` / `正太` / `JS` / `幼`
都是 pixiv 上的正常标签，请求「来张合法萝莉色图」就是一次普通搜图——实测 pixiv 标签「合法萝莉」有
4774 条结果，能不能发出去由 `socialV2.image.rating` + `ratingWords` 决定，不归这一层管。
真实事故：私聊发「来张随机的合法萝莉色图」被这一层按 `萝莉` 拦掉、AI 连看都没看到（`state/qq-activity.log`
里记成「已拦截越线请求（命中「萝莉」）」）。要对某个群单独收紧就写 `extraPatterns`，别改默认值。

这一层管的是「**要不要为这条消息花一次推理**」，不管「这条消息该不该接」：内容门槛由
`socialV2.image.rating`（safe / mild / r18）+ `ratingWords.explicitExtra` 在图源侧把着，提示词层
（preset 的 21b / 桥接每轮注入的【要图请求】）明确**不再做内容审查、不做年龄判断**，两级之间不再有
「模型按自己的线拒掉」这一环。改 `config.json` 后需要重启桥接生效。

自检：`npm run test:moderation`（纯函数 + 断言 preset/注入提示里不再有内容审查话术）。

### 5.8 AI 图片管理（控制台「AI 图片」分区）

AI 不只是「记住」东西，还会**往本机落图**。这些图以前只有「写」没有「管」——控制台看不到占了多少盘，
想删只能进 shell 里 `rm`。控制台左侧「AI 图片」分区（`🖼️`）把它们收成一个可管理的入口，
对应 `src/image-admin.js` + `/api/ai-images*`（**只允许控制台**：带 `x-agent-token` 一律 403——
AI 可以看图、发图，但不该能删管理员的图库）。

| 来源 | 默认目录 | 谁写进去 | 删掉会怎样 |
|---|---|---|---|
| 本地图库 | `assets/stickers`（跟 `socialV2.image.libraryDir` 走） | `scripts/fetch-bili-images.mjs` / `fetch-style-stickers.mjs` 等抓图脚本 | AI 选图/存表情少一张；`index.json` 条目会同步摘掉，还原时一起回来 |
| pixiv 抓取样例 | `state/pixiv-picks` | 抓 pixiv 榜单时的落盘样图 | 不影响 AI 发图，只是本地少个参考 |
| B站视频帧缓存 | `state/video-cache` | `qq_video_frames` 下载的雪碧图 | 下次看同一期视频重新下载（它自己也有 200MB LRU 上限） |
| AI 发出去的网络图 | `state/sent-images` | 桥接在发图 / 存表情时顺手落一份（`src/sent-images.js`） | 只影响本地回看；QQ 里已经发出去的消息不受影响 |

能做的事：

- **清单**：每类来源有多少张、占多少盘、最近一张是什么时候；图库还会标出「索引失联」（index.json 里有、磁盘上没有）
  与「未入索引」（磁盘上有、index.json 没记）；回收站占用单列。
- **缩略图网格**：直接看图（走 `/api/ai-images/file?source=&name=`，同样是控制台鉴权 + 浏览器 Cookie），
  点开可看原图；搜索文件名/标题/出处，按时间或体积排序。
- **逐张删 / 按来源清空**：勾选删除或整目录清空。
- **自然清理**：先按「保留天数」清太旧的，再按「总容量上限」从最旧的开始补删到预算内（两条规则 0 = 不启用，
  至少开一条，否则拒绝执行——避免「点了没反应」）。
- **回收站**（`state/image-trash/`）：**删除 = 移动到回收站**，不是 `unlink`。批次带 manifest，
  能整批或逐张还原（还原时把当初摘掉的图库索引条目一起放回去）；目标目录已有同名文件时跳过、不覆盖。
  「彻底删除」才是真的抹盘。回收站超上限（`imageAdmin.trashMaxMB`，默认 500MB）时从最旧的批次开始丢，
  **最新那批永远留着**——否则上限一紧就成了「刚删就没了」，回收站变摆设。
- **发送即落盘（`state/sent-images/`）**：`qq_send_image` / `qq_save_sticker` 的链路是「下载 → 校验 → base64 → 网关」，
  字节只在内存里过一遍。以前这意味着**群里发过的那张图本地再也找不回来**（会话记录里只剩一条会过期的 URL），
  于是有了「找不到之前发的那张图」这种事。现在解析出字节时就落一份，`index.json` 里记来源 URL、哪个会话、档位、
  是否真的送达（QQ 审核静默吞掉的那张会标 `delivered:false`）；同一张（sha256 相同）只存一次，超上限
  （`imageAdmin.sentImagesMaxMB`，默认 300MB）从最旧的开始丢。
- **补抓历史发过的图**：本次改动之前发出去的图没有字节可留，只能把 URL 捞回来重下——
  候选来自会话的 `recentMessages`（自己发过的带图消息）与 `state/bridge.log` 的 `[image] ... https://...` 行，
  重新下载走的是与发图完全相同的回退链（pixiv 会自己走代理、必要时换档位）。做成**后台任务**
  （一张图可能要几秒到几十秒，同步接口早超时了）：`POST /api/ai-images/backfill` 启动、`GET` 看进度，页面轮询显示。
- **缓存联动**：删/还原图库文件后桥接立刻让 `loadImageLibrary` 的 30s 缓存失效，
  否则 AI 在自己的 TTL 窗口里还会「看见」一张已经不存在的图。
- **安全边界**：只认注册过的来源；文件名必须是纯文件名 + 图片后缀；路径解析后必须仍在来源目录内
  （符号链接按 realpath 再核一次，指向目录外的软链既不能预览也不能删）；
  来源目录不存在、名字带 `../`、未知来源都会明确报错而不是「什么都没发生」。
- **配置**（`config.json` 的 `imageAdmin`，可选）：`trashMaxMB`（回收站上限）、`sentImagesMaxMB`（发送历史上限）、
  `sources`（覆盖受管来源，多机部署/测试时把目录指到别处；留空即用上表默认）。
- **API**：`GET /api/ai-images`、`GET /api/ai-images/items`、`GET /api/ai-images/file`、`GET /api/ai-images/trash`、
  `GET|POST /api/ai-images/backfill`、`POST /api/ai-images/{remove,clear,forget,restore,purge}`。
- **控制台必须能用子路径反代**（实测踩过）：控制台里的地址一律**相对当前页面**（`api/...` / `console/...`，
  绝不能以 `/` 开头）。有人把控制台挂在 `https://anihub.xin/local-web/http/127.0.0.1:3100/` 下访问时，
  根绝对地址会跑出那个前缀、打到反代自己的根上，返回的正是 `{"error":{"code":"NOT_FOUND","message":"接口不存在"}}`
  ——而「点击缩略图」当时用的就是服务端拼出来的根绝对地址，于是张张点不开。
- **自检**：`npm run test:images`（纯函数层，临时目录）与 `npm run test:images:e2e`（起隔离桥接打真实 HTTP）。

> 与「AI 记忆」的区别：记忆是 JSON，删错能整份快照回滚；图片动辄几十上百 MB，每次动手都复制一份不现实，
> 所以这里用回收站而不是 `state/backups/`。两者都在「语料」分组里，一左一右。

### 5.9 表情包管理（控制台「表情包」分区）

AI 发不发得对表情，取决于「备注/标签/笔记能不能对上语境」，而这些以前只有 AI 自己用
`qq_sticker_note` 写、管理员在控制台看不见也改不了。控制台左侧「表情包」分区（`😄`）把
**QQ 账号收藏夹**（`fetch_custom_face_detail` 拉回来的那批）镜像成可管理的入口。

**两套备注必须分清**（这是这个分区存在的主要理由）：

| 字段 | 是什么 | 谁能看到 | 怎么改 |
|---|---|---|---|
| `desc` | **QQ 官方备注**，存在 QQ 收藏夹里 | 全 QQ 可见 | 控制台「保存 QQ 备注」→ `modify_custom_face` |
| `localRemark` | **本地备注**（短名 ≤40 字） | **只有 AI 看得到** | 控制台「保存本地认知」→ `/api/stickers/note` |
| `localNote` | AI 的长笔记（看图后的理解） | 只有 AI | 同上（AI 也能用 `qq_sticker_note` 写） |
| `tags` / `usage` | 标签与「什么场合该发它」 | 只有 AI | 同上 |

AI 选表情时的取名优先级是 `localRemark` → `desc` → `localNote`（见 `buildStickerContext`）：
想让 AI 认得更准，改**本地备注**，不要去动 QQ 那份全 QQ 可见的备注。

**没备注的表情由 AI 自己看图补上**（线上实测：一个 75 张的收藏夹里有 **51 张**三样备注全空——
QQ 只存图不存含义，这些表情对 AI 等于「看得见、认不出」）：

- 唤醒提示的表情段里会带一行欠账：「有 N 个表情还没有任何备注」+ 补法（只在真有欠账时出现，不占常规上下文）。
- `qq_list_stickers(onlyUnlabeled=true)` 只列这类（返回里的 `unlabeled` 是当前欠多少条）；
  `qq_get_sticker_image` 看图 → `qq_sticker_note` 写 `localRemark`（≤40 字短名）+ `note` + `tags`。
- 节奏是**一轮最多补 1~2 个**（顺手做的事，不能把聊天刷成打标签任务，也不许在冷场时专门开一轮打标签）；
  已经有 `localRemark` / `desc` / `localNote` 的**不许覆盖**；必须看图写，不能照文件名（哈希）猜。
- **必须「看完一张立刻写掉」**：线上出过真事故——AI 先把两张图都看完、再一起写备注，
  结果把 A 的描述写到 B 上（`faker_憋笑` 与 `柴郡猫猫_点赞` 的笔记互换，管理员一眼看出来了）。
  所以三处提示（唤醒提示 / 手动按钮的提醒 / preset+角色卡）都写死了「一张一张来」，
  `qq_get_sticker_image` 的返回里也带上「QQ备注/本地备注」当文字锚点，并在图前提醒「要用这个 id 写，别串」。
  > 这类错误**只能靠提示压概率，不能靠代码根除**——工具是按 id 精确取图的，id 不会串，
  > 串的是模型把「看到的内容」和「要写的 id」配错了对。所以给锚点 + 拆步骤是唯一有效的方向；
  > 管理员发现写串了直接在该表情详情里改回来即可（本地备注/笔记都能覆盖写）。
- 判定「算不算没备注」的纯函数是 `stickerNeedsRemark()`（三样都空才算），三处共用，避免口径漂移。
- 控制台「表情包」分区会把「待补备注 N」显示出来，并提供**只看没备注的**筛选——AI 补完这里就归零，
  你也可以直接在详情里补。
- **要不要让它自己补，控制台有开关**：`socialV2.sticker.autoLabel`（默认开）。
  「表情包」分区顶部那个「AI 空闲时自己补备注」勾选框，和「二代仿真模式 → 表情包 ⚙」里的同名项是同一个 key；
  关掉后唤醒提示里**连欠账都不出现**，AI 自然不会再补（已写的备注与手动补备注不受影响）。
  > 只管「催不催」这一层：提示是唯一驱动（线上实测模型会绕过弱提示），所以开关也卡在这里，
  > 而不是去禁工具——你想手动让它补时，`qq_sticker_note` 照样能用。
- **旁边还有「让 AI 现在补一批」按钮**（`POST /api/stickers/autolabel-now`）：不想等它自己想起来时点一下，
  桥接会挑白名单里的第一个会话（群优先）投一条**静默后台提醒**，把**具体 id 直接写进提醒**里，
  AI 立刻看图 → 写备注，补完自己收尾、不会在群里说话。
  - 用哪个会话**不影响结果**：备注写在同一份 `state/stickers.json` 里，会话只决定借哪个 agent token 干活，
    所以不需要让管理员选会话。
  - 有 **30 秒冷却**（`sticker.manualLabelCooldownMs` 可调）并返回 429——这是「叫人干活」的按钮，
    连点只会往 prompt 队列里塞重复任务。
  - 与「后台提醒」共用 `notifyAiSession()` 一条投递路径（校验、静默回合语义完全一致），
    两条路各写一遍必然会漂移。
- **一次补几个是可调的**（默认值偏保守，线上 40+ 个欠账按默认要跑十来轮）：

  | 设置 | 作用 | 默认 | 范围 |
  |---|---|---|---|
  | `sticker.autoLabelPerTurn` | 自动补时**一轮最多几个**（提示里的「本次就补这 N 个」会跟着变） | 2 | 1~6 |
  | `sticker.manualLabelCount` | 手动按钮**点一次要几个**（也可在请求里传 `count` 覆盖） | 5 | 1~10 |
  | `sticker.manualLabelCooldownMs` | 手动按钮冷却 | 30000 | 5s~5min |

  三个都在「表情包」分区那一行（开关旁的两个数字框）和「二代仿真模式 → 表情包 ⚙」里；
  提示里的具体 id 数量、措辞（1 个时说「本次就补这个」）都会跟着配置走，
  所以调大/调小都真的生效，不会出现「改了配置但提示还写死两个」。

- **缩略图走桥接代理**：`GET /api/stickers/image?stickerId=`。不让前端直接引用 `p.qpic.cn` 直链——
  QQ 图床会校验 referer/时效（浏览器直连常 403），而且那样等于把「收藏了哪些表情」暴露给第三方。
- **写操作**（都只允许控制台，带 `x-agent-token` 一律 403）：`POST /api/stickers/{sync,note,remark,promote,delete}`，
  分别对应「同步收藏夹 / 改本地认知 / 改 QQ 备注 / `move_custom_face_to_front` 置顶 / `delete_custom_face` 删除」。
- **删除的顺序**：先在 QQ 侧删成功，再动本地库——失败时本地保留，避免「本地没了、QQ 还有」的错位。
- **实现文件**：`src/sticker-lib.js`（纯函数）+ `public/console/views/stickers.{html,js}`。
- **自检**：`npm run test:stickers`（含本地备注不被 QQ 同步覆盖、AI 摘要优先用本地备注）
  与 `scripts/test-audit-bridge.mjs` 里的「表情包管理接口」用例（含 AI 越权 403）。

---

## 6. 配置全解

> 仓库不包含真实 `config.json`，请参考 `config.example.json` 创建自己的配置。以下字段均以占位符/默认值说明。

| 字段 | 说明 |
|---|---|
| `dsh.baseUrl` | DSH Web API，默认 `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token；新版 DSH 用它换取 Cookie。留空时自动从 DSH guard 日志发现，401 后自动重新发现 |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段；当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` / `httpUrl` | OneBot WebSocket / HTTP API 地址；`httpUrl` 不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot 鉴权 token，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（进程管理用，默认禁用） |
| `ownerQQ` | 管理员 QQ（最高权限，可在控制台「白名单 / 管理员」设置） |
| `agentPreset` | 聊天模式用的 DSH agent preset |
| `workspaceTitle` | DSH 工作区名 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组） |
| `deny.private` / `deny.groups` | 黑名单 |
| `allowAllWhenEmpty` | 白名单为空时是否放行（fail-closed，默认 false） |
| `sendDelayMs` | 非社交模式每条消息间隔 |
| `consolePort` | 控制台端口，默认 3100 |
| `consoleToken` | 控制台鉴权 token；空=启动时自动生成并保存到 `state/console-token` |
| `security.interceptNotify` | 回复被安全拦截时是否在群里发提示 |

社交参数（控制台可调）包括：触发概率、活跃检测间隔、回复延迟、活跃时长、冷场窗口、试探概率、沉默概率、上下文窗口、单条长度上限、分条间隔、主动开话题参数等。

黑话学习参数包括：`slang.enabled`、`extractMinMessages`、`extractCooldownMs`、`inferenceThresholds`、`injectMax`、`learnerPreset`、`workspaceTitle`、`autoResearch`。

二代仿真参数包括：`socialV2.enabled`、`tools.*` 开关、`wake.*`、`send.*`、`wait.*`、`sticker.*`、`proactive.*`、`feedback.*`、`context.*`。

---

## 7. 安全机制

1. **白名单**：`allowed()` 统一 allow/deny/allowAllWhenEmpty；MCP 工具同语义。
2. **纯文本发送**：MCP send 用纯文本消息段，禁止 CQ 码注入。
3. **敏感审计**：`SENSITIVE_RE` 拦截路径/凭据；agent 回复、错误文本、审批/提问理由、MCP send 都会过。
4. **管理命令**：`/` 命令仅 owner（ownerQQ 可在控制台设置）。
5. **审批**：非 owner 不能通过审批；超时/覆盖会给 DSH 回执。
6. **进程控制**：`start/stop_snowluma` 默认禁用；即使开启，也仅允许在 `closed-agent` 模式下调用。
7. **配置 fail-closed**：config.json 损坏直接退出；白名单默认不放行。
8. **控制台鉴权**：可配 `consoleToken`；未配置时自动生成强 token。凭据可用三种形式之一提交：`x-console-token` 请求头、`?token=` 查询参数、或首次验证通过后下发的 `qq_console_token` Cookie（HttpOnly + SameSite=Strict，30 天）——浏览器直接导航/刷新带不了自定义请求头，没有这个 Cookie 每次刷新都要重输令牌；点控制台里的「忘记本机令牌」可立即清除。
9. **只读联网搜索**：`mcp-web-search-safe.js` 只暴露 `web_search` / `web_fetch`，带 SSRF 防护。
10. **黑话人工确认**：自动提取/联网研究的黑话默认 candidate，只有控制台确认后才注入聊天上下文。
11. **日志脱敏**：日志统一经过 `redactSensitiveText`，不记录路径/凭据等敏感原文。
12. **二代会话隔离**：每个二代会话生成独立 agent token，MCP 状态/发送工具必须携带 token。

---

## 8. 启动 / 运行

- `start.bat`：守护启动（自动拉起、崩溃重启）。
- `restart.bat`：停止旧 bridge 进程并重新拉起。
- 控制台：`http://127.0.0.1:3100`（左侧导航分区：总览 / 一代仿真 / 二代仿真 / 黑话与向量检索 / 群知识库 / AI 记忆 / AI 图片 / 表情包 / 人格与静默 / 白名单与安全 / 运维 / MCP 工具）。
- 模式：在**控制台「总览」的运行模式按钮**切换（桥接会写穿到 DSH settings 的 `qq-mode`，并同时写 `state/mode.json` 作兜底）。读取时 **DSH 设置为准**，`state/mode.json` 只在 DSH 侧不可用时兜底 —— 所以别直接改本地文件。运行 `scripts/setup-dsh.mjs` 的全新环境默认 `reserved2`。

### 控制台前端结构（改 UI 前先读）

控制台曾经是一个 2800 行的单文件 `public/console.html`（HTML + CSS + 1700 行内联脚本全塞在一起）。
现在拆成 **外壳 + core + 每分区一对文件**，无构建步骤、浏览器直接跑原生 ES module：

- 路由：`#/<view id>`；切换分区时旧分区 `unmount`、其轮询全部 `stopAll()`，只有当前分区在轮询。
- 每个 view 导出 `{ id, title, icon, group, order, desc?, badge?, mount(root) }`，`mount` 返回可选的清理函数。
- 静态资源由 `src/bridge.js` 的 `/console/*` 路由提供：只读、路径限制在 `public/console/` 内、
  扩展名白名单、**不需要令牌**（`<script type="module">` 带不了自定义请求头）；
  数据接口 `/api/*` 与外壳 `/` 仍然全部要令牌。
- 新增分区 = 写 `views/xxx.js` + `views/xxx.html`，在 `app.js` 里 import 并加进 `VIEWS`。
- **地址一律相对当前页面**（`api/...`、`console/views/x.html`、`index.html` 里的 `console/app.js`），
  **不要写 `/api/...` 这种根绝对地址**：控制台常被反代在子路径下（如
  `https://anihub.xin/local-web/http/127.0.0.1:3100/`），根绝对地址会跑出前缀、打到反代自己的根上。
  `core/api.js` 的 `api()` 与 `core/fragments.js` 已经统一去掉开头的 `/`；服务端拼给前端的地址
  （比如图片缩略图 `thumb`）也要按相对路径给。
- 鉴权：外壳 `/` 与 `/api/*` 要令牌；首次用 `?token=`（或请求头）通过后，桥接下发的
  `qq_console_token` Cookie 就是后续导航/刷新的凭据，前端因此不需要把令牌塞进 URL。
  前端 `core/api.js` 仍会带 `x-console-token`（localStorage 那份），两边任一有效即可。

**交互约定（改控件前先确认属于哪一类）**：

| 类别 | 外观 | 生效方式 | 实现 |
|---|---|---|---|
| 单点开关（工具开关、各种「启用」） | `input.switch` 拨动开关 | 拨动即写 config.json、立即生效 | 各 view 里的 `SWITCH_FIELDS` + 一个委托的 `change` 监听；失败会把开关拨回去 |
| 成组参数（数值/概率/文本/多选） | 输入框 | 改完点「保存…」 | `core/dirty.js` 的 `trackDirty()`：显示「有 N 项未保存」、点亮保存按钮、切分区/关页面时拦一下 |
| 列表选择（黑话批量操作） | 普通勾选框 | 只影响选择状态 | 不写配置，`data-*` + 事件委托 |

`trackDirty()` 只把**用户动过**的改动算成未保存：基线重建后，用户还没碰过那块区域
（`pointerdown`/`keydown`/`focusin`，弹窗要传 `interactionScope: '#v2CfgBody'`）时凭空出现的值
一律并进基线。因为浏览器密码管理器会在弹窗打开时自动填充密码框——那不是用户的改动，
否则「点开 qq_video 的 ⚙ 再点取消」也会弹出「还有 1 项没保存」。新增密码框时记得
`autocomplete = 'new-password'`（`scripts/test-console-views.mjs` 会守住这条）。

服务端的配置接口（`/api/socialV2/config`、`/api/social`、`/api/slang/config`、`/api/security`）
都是**字段级/子分区深合并**，所以「只提交一个开关」不会碰其它字段——这是开关能即改即存的前提。

**参数区的排版约定（改 markup 时别破坏）**：

- 一行字段 = `<div class="form-row"><label>标签</label><div class="ctl">控件</div></div>`；
  一行两组（如「启用 X ｜ 预设 Y」）= `.form-row.pairs`，四列 `标签 控件 标签 控件`。
- 连续的 `.form-row` 外面套一层 `.form-grid`（宽屏自动 2~3 栏）；`.pairs` 独占整行。
- 标签列在 CSS 里固定 188px、数字框统一 96px，所以**不要再给控件写死 `style="width:NNpx"`**，
  也不要把标签写在 `.ctl` 外面——否则输入框左边缘又会参差不齐。
- 行内的补充说明放在 `.ctl` 里（`.meta`），直接放外面会掉到标签列下面。`tools/scripts` 里
  `test-console-views.mjs` 只校验 id 一致性，排版这类问题靠肉眼或 jsdom 结构检查。

### 常用调试/测试脚本

| 脚本 | 用途 |
|---|---|
| `scripts/test-console.mjs` | 控制台 API 自检 + 分区片段/静态路由自检 |
| `scripts/test-console-theme.mjs` | 控制台主题回归（浅色默认 / 深色持久化 / 变量一致性） |
| `scripts/test-console-views.mjs` | 控制台前端结构自检（分区契约 / import / #id / 配置分区开关） |
| `scripts/test-console-router.mjs` | 分区路由回归（重复 hashchange、挂载竞态、未保存离开守卫） |
| `scripts/test-console-dirty.mjs` | 未保存追踪回归（自动填充/程序写入不算改动、用户操作才算、离开守卫） |
| `scripts/test-mcp-safe.mjs` | MCP 安全工具自检 |
| `scripts/test-member-remarks.mjs` | 群成员备注自检（纯函数 + 隔离实例真发 `set_group_card` 到假 OneBot） |
| `scripts/test-content-filter.mjs` | 入站内容策略自检：纯函数 + 隔离桥接确认「消息没进未读、没触发唤醒、桥接回了固定话」 |
| `scripts/test-memory-admin.mjs` | AI 记忆管理自检：`npm run test:memory` 纯函数层（清单/增删/钉住/自然遗忘/备份回滚/路径穿越），`npm run test:memory:e2e` 追加真实桥接的 `/api/memory*` 接口回归 |
| `scripts/test-image-admin.mjs` | AI 图片管理与发送历史自检：`npm run test:images` 纯函数层（清单/搜索/删除→回收站/还原/清空/彻底删除/自然清理/容量淘汰/符号链接与路径穿越/发送落盘去重与淘汰），`npm run test:images:e2e` 追加真实桥接的 `/api/ai-images*`（含补抓进度接口）回归 |
| `scripts/test-card-parse.mjs` | 卡片消息解析自检（真实卡片 payload + json/xml/share/合并转发） |
| `scripts/test-html-text.mjs` | web_fetch 的正文抽取 / SPA 识别自检（含误报防护） |
| `scripts/test-browser-render.mjs` | web_render 自检（过滤代理 SSRF 边界 + 本地假 SPA 渲染） |
| `scripts/test-mcp-host.mjs` | MCP 进程管理自检 |
| `scripts/test-mcp-web-search.mjs` | Web Search / Fetch MCP 自检（含内网拦截） |
| `scripts/test-onebot-connection.mjs` | OneBot 连接自检 |
| `scripts/send-test-group.mjs` | 向指定名称的群发测试消息 |
| `scripts/check-onebot-status.mjs` | 网关状态 |
| `npm run self-test` | DSH 侧链路自检（不依赖 QQ） |

---

## 9. 开发 / 改进指南

### 常用验证

```bash
npm run check          # 全仓库语法 + 未声明标识符（不依赖 eslint）
npm run check:dead     # 额外列出疑似死代码
npm run test:audit     # 离线审计套件（桩环境，不碰真实 QQ/DSH）
```

控制台前端语法校验（每个模块单独 check，ES module 不会被当脚本执行）：

```bash
for f in public/console/app.js public/console/core/*.js public/console/views/*.js; do node --check "$f"; done
node scripts/test-console-theme.mjs   # 主题/变量回归（不需要桥接在跑）
```

### 重启

```bash
restart.bat
```

---

## 10. 常见问题

### Q：活跃期回复不及时？

- 群聊走轮询：`activeCheck` 10~30 秒 + `activeReplyDelay` 2~8 秒。
- 调小这两个参数；私聊已改为即时投递。

### Q：为什么有的消息没回？

- 普通闲聊可能被 `skipProbability` 沉默（但会进 `silentContext`，下次投递模型能看到）。
- 直接提问/@/私聊不会沉默。

### Q：为什么拆条有时不拆？

- 现在分句权在 AI：AI 没用空格分隔就不会拆条。
- 单条超过 `maxReplyChars`（默认 500）会安全硬拆。

### Q：MCP 工具改了不生效？

- MCP 由 DSH 拉起，修改 `src/mcp-*.js` 后需要**重启 DSH 进程本身**（不是只重启 qq-bridge），或让 DSH 重连 MCP。
- 修改 DSH preset 或 `cordis.patch.yml` 后，同样需要重启 DSH。

### Q：黑话提取/联网研究没生效？

- 确认 `slang.enabled` 为 true、DSH 在线、某会话消息已攒够 `extractMinMessages` 条。
- 联网研究需要 DSH 学习会话能使用 `web_search` 工具。
- 黑话候选不会自动转正，需到控制台「黑话管理」人工确认。

### Q：有些梗豆包认得、我们的链路查不到，能不能接豆包当知识源？

能接，但**「当知识库」是错的定位** —— 这是整个设计的前提。

豆包是**模型不是知识库**：问它一个梗，它几乎不会说「我不知道」，而是编一个听起来很合理的解释。
而黑话库里的释义会**进每条唤醒提示**，所以把模型输出直接写进去等于每天自动投毒。
（代码里 `slang.autoConfirmResearched` 默认就是 `false`，也是为了这个。）

#### 接的是「一路佐证」，不是答案

位置只放在**异步考究链**（`runSlangResearch`），不碰同步的 `qq_lookup_meme`（那有 4 秒硬预算，
塞个浏览器进去只会把回复拖垮）。链路变成：

```
候选梗 ──► B站证据（实抓视频/高赞评论）──┐
       └─► 豆包说法（模型口述，参考）  ──┴─► 研究会话（deepseek + web_search）──► 交叉验证 ──► 入库
```

#### 护栏：结构化，不靠 prompt 自觉

判定在 `src/doubao-research.js` 的 `decidePromotion()`，是个纯函数（可离线单测）：

| 证据 | 判定 |
|---|---|
| B站有 ≥1 条评论或 ≥2 个视频（`strong`） | 按 `autoConfirmResearched` 决定是否自动转正（原行为） |
| **只有豆包给了释义（`doubao-only`）** | **永远不自动转正**；释义和 `evidenceLevel` 记下来，等独立证据 |
| 什么外部证据都没有（`weak`） | 保持原行为 |

也就是说：**豆包单独一路不足以让一个词条生效。** 它要么和 B站证据对上，要么等群里出现真实用法。
被拦下的条目会带 `researchVerdict: 'doubao-only'` 和 `researchNote`，控制台能筛出来人工看。

提示词那层也做了降权（`buildResearchPrompt` 的 `doubaoEvidence` 段）：明确写「这段是模型凭训练知识答的，
不是实抓证据，它不知道也会硬编」，并要求与 B站冲突时以 B站为准。

#### 传输：网页版自动化，不是 API

`src/doubao-worker.js` 驱动无头 Chrome 打开 `doubao.com/chat`，协议是 stdio 上的 JSON 行。
几个实测踩出来的关键点，改这块之前先看：

- **登录**：要扫码。二维码**不是** canvas 也不是 data: 图片，而是一个 **162×162 的 `<svg>`**，
  正下方有一行「打开 豆包 / 飞书 App 扫码登录」——按「最大的方形 svg 且在扫码文字上方」定位。
- **推广弹窗**：首屏会弹「下载电脑版领 30 天订阅」，**正好盖住右上角登录按钮**。
  不先按 Esc / 点关闭，点「登录」就是静默无效。所以每次进页面都要先 `dismissOverlays()`。
- **输入框**：tiptap / ProseMirror 的 contenteditable。`el.focus()` + `page.keyboard.type()` 最稳，
  `execCommand('insertText')` 兜底。**失败基本都是在编辑器挂上之前就动手了**——要轮询等，不能 goto 完就找元素。
- **回答抽取**：不靠 class（同一 URL 两次加载 DOM 都不一样），而是**发送前后整页文本做差集**。
- **profile 会攒僵尸标签**：跑几轮后能攒出十几个 `about:blank`，之后 `page.evaluate` 一直报
  detached frame。靠 `--no-restore-session-state` + 启动时关掉继承标签解决。

#### 内存：这条是硬约束

worker 由 `src/doubao-web.js` 用 `systemd-run --scope -p MemoryMax=900M` 起在**独立 cgroup** 里。
本机 1.6GB 内存、长期只剩一两百 MB 可用（还挂着几 GB swap），
跑在 bridge 进程内一旦 OOM 就是 bridge / DSH / QQ 一起死；独立 cgroup 只死 worker。
没有 systemd-run 时会退化成普通 spawn（控制台会红字提示「无法限制内存」）。

生命周期：**懒启动 + 空闲 5 分钟自杀**，不常驻。参数在控制台
**黑话 / 向量检索 → 豆包网页版通道**，或 `config.json` 的 `slang.doubao`：

```json
{ "enabled": false, "memoryMax": "900M", "idleCloseMs": 300000, "timeoutMs": 90000, "maxTerms": 3 }
```

`maxTerms` 默认 3：一轮研究最多问几个词（每个十几秒，且共用一个浏览器）。
`enabled` 默认 `false`——要先扫码登录，且它吃内存，不该默认开。

#### 掉登录 / 改版了会怎样

任何失败都走**同一条降级路径**：`collectDoubaoEvidence` 返回空 → 研究会话照常跑（只是少了这一路证据）
→ 词条进 `weak`/`strong` 判定。也就是说**豆包通道坏掉不会让研究停摆**，
但也不会有任何「这个梗查不到」的表现，所以控制台的通道状态要定期看一眼。

> 踩过的坑：**「接网页版」和「接 API」的成本差一个数量级。** 如果哪天嫌它太脆，
> 火山方舟（页面侧栏就有「API 服务」入口）是同一个豆包模型，也能挂联网插件，
> 换成 HTTPS 请求后这一整节（登录、DOM、内存、systemd-run）全都不需要。

回归测试：`scripts/test-doubao.mjs`（40 项，含「只有豆包一路绝不自动转正」的核心断言）。

### Q：AI 不知道该不该发表情包 / 收藏里没有合适的？

- 二代仿真模式有专门的 `qq_pick_sticker`：先判时机（冷却、本轮是否已发过、语境是否偏严肃），
  再从「QQ 收藏表情 + 本地图库」里按语境打分排序给候选；本地都不够好时自动联网找一批
  （搜索词会叠加 `sticker.pick.styleKeywords` 的风格偏置，默认偏二次元/Q版/梗图/DeepSeek 二创）。
- 参数在控制台 **07 二代仿真模式 → 表情包时机与选图**（`config.json` 的 `socialV2.sticker.pick`）：
  `minIntervalMs`（硬冷却，冷却内桥接直接拒绝发送）、`maxPerTurn`（每轮上限）、`minScore`（本地合格分，
  低于它才算「本地不满足」并触发联网）、`onlineFallback`、`librarySources`（默认只把 `style/manual/ai`
  当表情候选，`bili-cover/dynamic` 这类资讯配图排除在外）。
- 唤醒提示里每轮都会带一行「此刻发表情包」时机判断，AI 不用自己猜。
- 本地图库条目只有文件名/关键词、没有含义描述，选不准是正常的：`qq_pick_sticker` 传
  `preview: true` 会把候选图直接返回给视觉模型看一眼再决定。
- 想让本地池更好用，跑 `node scripts/fetch-style-stickers.mjs`（按风格关键词抓图入库，
  sha256 去重、幂等可重复跑；换新关键词才有新图）。

### Q：群友整蛊/钓鱼，AI 却老老实实答、还认真纠正自己？

以前是这样：提示里只写了「别人玩梗你就玩回去」，没覆盖**整蛊/钓鱼**这种对抗性场景——
模型默认行为是「老实回答 + 被指出错误就认真纠正/自证」，而那正是钓鱼的人想要的乐子。

现在三处（每轮唤醒提示 / preset / 角色卡）都写死了同一条 `【被整蛊不用老实答】`：

- **怎么认**：钓鱼/陷阱问题（「1+1=3 对不对」「你是不是傻」）、假消息求证、故意引你答错看笑话、
  反串引战、要你自证——对方要的不是答案，是看你上钩。
- **怎么回**：不必按字面回答、也不用纠正他。顺着演、反手整回去、把坑推回去、装傻、已读乱回，
  或一句短的（「？」「你说是就是」「查我干啥」「我信了」）。
- **已经被耍了/答错了**也一样：不用老实认错复盘，可以嘴硬（「我故意的」「你上钩了」）、装傻带过、反整他一下。
- **最忌讳**一本正经地纠正、写小作文自证、「其实不是这样」「作为 AI 我要澄清」。
- 边界：① 真问事（尤其技术/事实问题）就好好答，**别拿「整蛊」当偷懒借口糊弄**；
  ② 玩回去要短、要乐，别升级成骂战（要骂走【被挑衅可以骂回去】那套）；
  ③ 不配合造谣/违法/伤害第三方的坑（编假消息、说某人坏话、冒充别人）——不接或直接点破；
  ④ 被整了别记仇、别写进记忆，**也别把整蛊问题当知识沉淀进群知识库**。

> 顺带确认过：桥接没有出站内容过滤会改写这类回复（`SENSITIVE_RE` 只管本机路径/凭据，
> `content-filter.js` 是入站越线策略）。所以这条纯粹由提示驱动，改提示即生效。

### Q：多层合并转发（转发里套转发）AI 只看得到最外面一层？

以前确实如此，而且是两处叠加的：

1. **嵌套只展开一层、每个只给 3 条 × 120 字预览**。线上那条真实数据：外层 2 条，其中第 1 条本身是
   一个 **18 条**的合并转发——AI 只看到 3 条，表现就是「只有最外面一层」。
2. **本层没有分页**：一次最多 50 条，多的就看不到，也没法继续读。

现在：

- **按层递归展开**（`socialV2.forward.nestedDepth`，默认 2 层）：第一层嵌套每个给 12 条，
  更深的给 8 条，再深一层在各自的 `children` 里；每层最多展开 10 个（`maxNestedForwards`），
  整次请求最多再抓 20 条嵌套（`nestedFetchBudget`）——嵌套会分叉，没有总预算的话
  「转发套十个转发、每个再套十个」能放大成上百次网关调用。
- **能翻页**：本层返回 `total` / `offset` / `hasMore`，AI 带 `offset`/`limit` 继续读；
  嵌套层同理。`index` 是**绝对序号**，翻页不会错位。
- **能按嵌套 id 一层层查下去**：返回里 `nestedPreviews[].id`（以及更深的 `children[].id`）
  都可以直接当 `id` 再调一次本工具，拿到那一层的完整内容；桥接会把这些 id 登记成
  「本会话已见过」，所以安全闸门会放行。
- 返回里带一句 `note` 把这些用法讲清楚，AI 不用猜。

> **踩到的真 bug**：`URLSearchParams.get()` 缺参数返回 **null**，而 `Number(null) === 0`，
> 被当成「显式传了 0」压到下限——表现是「没传 `limit` 时本层只给 1 条」。已修（null/''/undefined
> 一律走默认值），并加了回归用例。

### Q：合并转发里的图，AI 那边报 `Maximum call stack size exceeded`？

那是**给模型的图太大**。线上实测：转发里一张 3.75MB、1920×2560 的 PNG（照片存成 PNG）
没撞既有的 4MB 硬上限，被原样投给模型，上层图片归一化直接爆栈。

所以给视觉投喂加了一道**舒适区软上限**（`fitMediaBuffer`）：

- 硬限仍是 4MB / 6400 万像素（撞了必压，压不动就丢）；
- 但即使没撞硬限，只要 **>1.5MB 或 >250 万像素**，也主动压到舒适区内（长边 ≤1600 的 JPEG）——
  模型侧本来就会把图缩到 ~1MP 级别，塞原图纯属浪费上下文。
- 压完**反而更大**时保留原图（本来就压得很狠的 JPEG 不做无谓重编码，避免掉画质）。

实测那张图：**3751KB → 176KB**（日志：`图片超视觉舒适区，已压缩后投喂`）。

### Q：AI 说合并转发（聊天记录）里「只能看到前五张图」？

那是三层写死的上限叠在一起，光调一层没用：

| 层 | 原来的值 | 表现 |
|---|---|---|
| MCP 工具 `qq_get_forward_msg` | `images.slice(0, 5)` | 只把前 5 张交给桥接 |
| 桥接 `fetchMediaData()` | `MAX_MEDIA_COUNT = 5` | 第 6 张起标「已跳过」 |
| 批总量预算 | 沿用单条消息的 `MAX_MEDIA_BYTES = 4MB` | 手机照片一张 ~1MB，**第 5 张就撑满**，后面全丢 |

线上实例：一条 15 张图的转发，AI 只拿到 4 张，还以为转发里就这么多。

现在改成窗口式：

- **分页**：`qq_get_forward_msg(id, imageOffset, imageLimit)`，返回里直接写「共 N 张，本次给了第 a~b 张，
  还有 M 张没看，用 imageOffset=b 继续」——AI 自己知道进度，不会再以为只有前几张。
- **单次上限可配**：`socialV2.forward.imageLimit`（默认 8）/ `maxImageLimit`（硬上限 20）。
  一次塞几十张会炸上下文，所以是「能翻页」而不是「一次全给」。
- **撞批预算先压小，不再整张丢**：`fitBatchBudget()` 会把当前这张压到剩余额度内，
  实在压不下（剩余 <40KB）才判超限。批预算本身也放宽到 `socialV2.forward.maxTotalBytes`（默认 16MB）。
- `index` 是**在整条转发里的序号**（不是窗口内序号），否则翻页会错位。

控制台：`二代仿真模式 → qq_get_forward_msg 的 ⚙`。自检见 `scripts/test-audit-bridge.mjs` 的
「合并转发图片：分页取、报总数、单次上限可配」与「批总量预算」两条用例。

### Q：AI 被骂了只会忍着 / 讲道理，能不能让它骂回去？

能，而且这是**明确允许**的行为（`【被挑衅可以骂回去】`）。以前不是被哪条规则拦着——
preset、人格卡、每轮唤醒提示里**都没有提过这件事**，模型默认就按「礼貌、讲道理、我不跟你一般见识」走，
于是挨骂只会忍着或解释。

现在这条许可写在三处（三处都要，各有各的坑）：

| 位置 | 为什么 | 生效时机 |
|---|---|---|
| `buildWakePromptV2` 的 base | 人格卡在二代**不是每轮注入**（提示里只给角色名，正文要 `qq_get_prompt` 才读到），所以每轮提示必须自带 | 改完重启桥接即刻生效 |
| `roles/小鲸鱼.md` | `qq_get_prompt` 读到的人格卡，保证两处口径一致 | 即刻 |
| `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 系统提示词，最稳的一层 | 需跑 `scripts/setup-dsh.mjs` 同步（DSH 0.2+ 写 profile 插件行并热加载，0.1.x 复制目录；会改组成戳 → 现有 QQ 会话被重建） |

**边界**（写在提示里，别指望模型自己把握）：对等还击不主动升级；只回击挑事的人、不牵连无关群友；
不拿家人/地域/性别/身体/疾病当武器；不用性侮辱与「操你妈」这类极端脏字（「滚 / 傻逼 / 神经病 / 你tm」这一档）；
对方收手就停；先分清玩梗和真挑衅——只是玩梗就按玩梗回敬，别真动气。

> 顺带确认过：桥接**没有**任何出站脏话过滤会拦它。`SENSITIVE_RE` 只管本机路径/凭据，
> `content-filter.js` 是**入站**越线请求策略（默认空规则）。所以想收紧只能改上面那三处。

### Q：AI 说话太像 AI（「行，」「所以」开头、破折号一大堆、一条四五十字）？

先用真数据量过一遍再说，别凭感觉改。`state/social-v2.json` 里最近 182 条 AI 发言 vs 68 条群友发言：

| 指标 | AI | 群友 |
|---|---|---|
| 用到破折号（`——`） | 18.7% | 0% |
| 以「行，」开头 | 5.5% | 0% |
| 以「所以」开头 | 5.5% | 1.5% |
| 平均一条字数 | 39.9 | 9.7 |

结论：不是「语气不够亲切」，是**排版习惯**出卖了它：AI 把每条闲聊都写成一段带转折的短评。
修法是把它往群友的语感上拽，同样写三处（唤醒提示 / 人格卡 / preset，原因见上一条）：

1. **别用公式化句式**：破折号（em dash）不要用、也不用「行，」「所以」「说白了」这类发语词开头，
   同一句式的收尾别连着用；一条 1~10 字，最多十来字。**措辞必须是绝对禁止**，不能写「别老用」（见下）。
2. **拿不准就看群里真人怎么打字**：他们怎么起头、怎么断句、一句多长、什么时候只回一个「？」。
   这条比任何形容词都管用，因为它是「去看数据」，不是「要亲切」。
3. **@ 点名**：要回的人不是最新一条、或几条消息指向不同的人时，直接在群里 @ 他（工具带 `atUserId`），
   比引用更自然。只在真需要指名时用，别句句 @。
4. **没人搭话时用表情包冒泡**：群友在聊跟它无关的话题，它可以插一张对味的收藏表情，不必硬接一句话
   （见上面「AI 不知道该不该发表情包」那条）。

#### 补：提示词压不住的，要加一层确定性清洗

上线一轮后回测（211 条 AI 发言）：

| 指标 | 条数 | 占比 |
|---|---|---|
| 以「行，」开头 | 6 | 2.8% |
| 以 `X：` 标签式开头 | 20 | 9.5% |
| 「总结：」 | 1 | 0.5% |

关键是**「行，」在提示词里已经点名禁过一轮了，当天照样出现两次**：

```
15:02:09  总结：加钱才有那一档体验，一分钱一分货
15:02:10  行，我先按S31那个价位看，谢了
15:09:02  行，S31和初耳NOVA都记本子上，谢了
```

原因写在规则自己身上：原来那句是「开场**别老用**这类发语词」——模型把「别老用」读成了
「偶尔用没关系」。**规则措辞的强度会被模型按字面打折**，所以改成了「**下列写法一个都不要用**（不是「少用」）」。

但只改措辞还是不稳，所以补了一层**出站口播清洗**（`src/speech-style.js`）：

- 位置：`sendMessagesV2` —— **所有** AI 文本发送的唯一收口（批量 / 单条 / 统一发送都汇到这里），
  只在这一处做，不用在每个工具入口重复。
- 范围：**只做机械删除，绝不改写**。目前只削两类，都要求确定性匹配：
  1. 句首发语词：`行`/`好的`/`好嘞` + 标点（全角半角句号逗号都认）
  2. 总结标签：`总结`/`小结`/`结论`/`综上`/`总之`/`总而言之`/`总的来说`/`一句话总结`/`一句话` + **冒号**
- **误伤防护**（这块比功能本身更要紧，测试里 13 条「一个都不能碰」）：
  - 「总结一下这周的进展」不动（标签必须带冒号）
  - 「这个方案行，我同意」不动（只削句首）
  - 「我总结：三条都成立」不动（句首不是标签）
  - 洗完只剩空白或只剩标点 → **保留原文**，绝不发出空消息或光秃秃一个标点
- 开关：`socialV2.style.scrubFormulaic`（默认开）。每次命中都会记日志，方便量真实发生率。

> 注意：削掉句首的「行，」在语义上**会丢掉那一声应承**（「行，那就这么办」→「那就这么办」）。
> 这是有意的取舍——线上那两条（「行，我先按S31那个价位看」「行，S31和初耳NOVA都记本子上」）
> 削掉后意思不变、AI 味明显降低。不能接受就关掉开关，退回纯提示词。

改动提示词后不用重启 DSH，重启桥接即可；preset / 人格卡那两份要 `scripts/setup-dsh.mjs` 同步。

回归测试：`scripts/test-audit-bridge.mjs` 的「反公式化」系列断言（措辞必须是绝对禁止、
总结标签必须点名、发送收口真的会削、开关能关），以及 `scripts/test-speech-style.mjs`（38 项，含误伤检查）。

### Q：群里在复读 / 发梗图转发，AI 却一脸懵或者认真求证？

这两件事的失败方式很像：**AI 把「玩」当成了「信息」**。

**复读**（同一句话被连刷、队形、同一个表情包连发）是群聊最常见的接梗方式。模型的默认反应是
「你们怎么都在复读？」「是不是卡了？」，或者把一串复读当成一串新消息逐条认真回应，两种都很出戏。
现在提示里写的是：不要惊讶、不要质疑、不要逐条回，一串复读当一条处理；
**合适的场合（正好戳中你、队形整齐、话题对味）自己也可以跟着复读**同一句短句或跟发同一个表情包，
别加解释和评论；没轮到你、或者插进去会打断别人玩的时候就看着。

> 注意跟「不值得开口：只会复述/总结/附和」区分开：那说的是没内容的附和，复读是有意的玩。
> 提示里专门写了一句「复读不算『只会附和』」，免得模型自己把两条规则对冲掉。

**梗图 / 转发的聊天记录、文章、截图**，里面的说法经常是反串、玩梗、段子或钓鱼，不是有人在向你陈述事实。
模型容易把它当成待核实的信息去求证、纠正、追问真假（「这不科学」「这是假的吧」），既扫兴又暴露它分不清语境。
现在写的是：有明显玩梗信号（离谱说法、夸张标题、圈内黑话、明显 P 图、一看就是段子）就按梗接、顺着玩；
真假难辨就不表态、一句「？」或一个表情包带过；**只有对方明确在跟你求证事实**（「这是真的吗」「帮我查下」）
才认真答，并说明来源；别把梗图/转发里的说法当事实写进轻量记忆或群知识库。

两处规则同样写三份（唤醒提示 / 人格卡 / preset，原因见上面「AI 被骂了只会忍着」那条）。
唤醒提示里的标识是 `【复读是正常玩法】` 与 `【梗图/转发消息多为反串玩梗】`，
回归测试见 `scripts/test-audit-bridge.mjs`。

### Q：QQ 掉线重登 / 网关抖动了，那段期间的消息 AI 还能拿到吗？

**现在能了（补拉）；在这之前是不能的，而且是整段静默消失。**

先看实测事故（2026-10-05 23:20:33–23:26:05 CST，桥接↔网关的 WS 每 30 秒 `code=1006` 抖了 11 次）：

```
15:20:33 SnowLuma 连接断开（code=1006），重连中…
… 连续 11 轮 …
15:26:47 SnowLuma 已连接
```

这段窗口群里发了 6 条，桥接**只收到重连后的 1 条**：

| seq | 内容 | 桥接 |
|---|---|---|
| 37213 | 怎么会有这么垃圾的英雄 | ❌ 丢 |
| 37214 | 席拉真是拉完了 | ❌ 丢 |
| 37215 | 设计太失败了 | ❌ 丢 |
| 37216 | 听说以前挺强的 | ❌ 丢 |
| 37217 | 那个光波 | ❌ 丢 |
| 37218 | 现在看来跟鸟人一样 | ✅ |

根因是 **OneBot 是推送模型**：断线期间网关不会重发，而桥接当时 `bot.on('open')` 只刷新了机器人昵称，
`bot.on('close')` 只打一行日志 —— 什么都没做。**AI 完全不知道那 5 条存在过。**

#### 补拉的依据：网关能按位置翻历史

实测发现的调用方式（这几条是实现的全部前提）：

```bash
{"group_id":G}                      → 只给最新 20 条
{"group_id":G,"count":400}          → 200 条，seq 37052→37251
{"group_id":G,"message_seq":37200,"count":50}  → seq 37200→37249（从指定位置往后取）
```

关键：**`message_seq` 单独传会被忽略**（37223/37100/36000 返回完全一样），**必须和 `count` 搭配**。
私聊走 `get_friend_msg_history`。

#### 实现（`backfillMissedMessages`）

1. 每条收到的消息记下网关侧的 `message_seq`（`gwSeq` → `st.lastGwSeq`）。
   桥接自己的本地 `seq` 是自增计数器，跟网关对不上，**不能拿来定位**。
2. `bot.on('open')` 后延 5 秒（等连接真稳下来，抖动时立刻连拉会把网关打满）调补拉。
3. 对每个允许的会话，从 `lastGwSeq + 1` 往后拉，过滤掉自己发的、按 `message_id` 去重。
4. **按时间归位插入**，不能直接 append —— 补回来的消息比「重连后已收到的那批」更早。
5. 更新 `lastGwSeq` / `lastUnreadSeq`。

**基线播种**：如果状态里没有 `lastGwSeq`（首次启用、或桥接重启后还没收到消息），
就从历史里找出「我们已认识的最新一条 message_id」，拿它的 seq 当基线。
这样**桥接自己重启期间**错过的消息也能补，而不是要等下一条消息才起步。

#### 唤醒闸门：补回来 ≠ 要回

补回来只保证**上下文完整**；要不要叫 AI 起来看是另一件事：

| 条件 | 行为 |
|---|---|
| 补回条数 ≤ `wakeMaxMessages`（默认 15）**且**最早一条 ≤ `wakeMaxAgeMs`（默认 10 分钟） | 入库 + 一次唤醒 |
| 超过任一闸门 | **只入库、不唤醒** |

补 5 分钟前的几条然后回一句很正常；补 4 小时前的 200 条然后逐条回就是灾难。
参数在控制台 **黑话 / 向量检索 → 掉线补拉**，或 `config.json` 的 `socialV2.backfill`：

```json
{ "enabled": true, "maxMessages": 100, "wakeMaxMessages": 15, "wakeMaxAgeMs": 600000 }
```

控制台还有一个「立即补拉一次」，出问题时可以现场验证（也可以直接打 `POST /api/socialV2/backfill`）。

> 已知边界：补拉是**向前扫描**的。如果缺口出现在中间（丢了 37213–37217，却先收到了 37218），
> 靠 `lastGwSeq` 往后扫是补不到那个洞的——正常情况下 `lastGwSeq` 会停在断线前那条，
> 所以能覆盖；但如果状态里的 seq 已经先被更新的消息推进了，中间洞就补不回来。

回归测试：`scripts/test-audit-bridge.mjs` 的 8 条「掉线补拉」用例
（能补回 / 不重复补 / 过滤自己发的 / 唤醒闸门两个方向 / 基线播种 / 开关关闭）。

### Q：AI 漏掉了某条消息（比如 @ 它、回答它问题的那些）？

这是「两次 `qq_wait_for_messages` 之间的缝隙」造成的，线上实例：AI 问「你活动在哪个镇」，
玄真回 `@哦鲸鲸 玉山镇`，那条消息**恰好落在上一次 wait 返回、与下一次 wait 开始之间**：

- 上一次 wait 的 `newMessages` 里没有它（那时还没到）；
- 下一次 wait 的 baseline 取的是「等待开始那一刻的最新 seq」，它的 seq 不大于 baseline；
- 但它在 `unread` 里。AI 的常见习惯是只看 `newMessages`、收尾 `mark_read`，
  于是被静默清掉——**永久丢失**。

现在用「投递水位」把缝补上：

- 新增持久化字段 `deliveredSeq`：**已经真正投递给 AI** 的最大 seq。
- `wait` 的 baseline 改用 `deliveredSeq`，所以「没投递过的未读」下次一定带上。
- `qq_get_unread_messages` / `qq_get_recent_messages` 也会推进水位（看过就不再重复投）。
- `qq_mark_read` **只清水位以内的**：从没给 AI 看过的消息会保留在未读里，
  回执带 `keptUnread` + 点名是哪条，并主动补一次唤醒（10 分钟护栏，防止反复 mark_read 变成唤醒风暴）。

> 升级到这套逻辑后的第一轮，`deliveredSeq` 会初始化为「当前最旧未读的 seq − 1」，
> 让升级前积压的未读也能被补投一次，而不是当作已看过。

### Q：群友发了消息，AI 一直不回（日志只有「会话繁忙，暂存唤醒原因」）？

这是**恢复机制漏了一条路径**，不是 DSH 真的在忙。线上实测：群友发消息后 AI 静默 8 小时，
`pendingWakeReasons` 堆满 20 条、`unread` 越积越多，而桥接日志只有一行行「会话繁忙」。

机制是这样：桥接用内存标记（`v2TurnStartAt` / `collectors` / `promptQueues` / `pendingWakeKeys`）
推断「会话是否忙」，标记残留时靠忙标记看门狗每 60s 回收一次。但看门狗**只认 `pendingSince`**，
而暂存唤醒有两条入口：

| 入口 | 场景 | 早先是否写 `pendingSince` |
|---|---|---|
| `sendWakePromptV2` | 唤醒真正投递时撞上回合 | ✅ |
| `scheduleWakeV2` | **群友发消息**（常规路径） | ❌ → 永远不被回收 |

于是只要残留标记出现在「群友发消息」这条路径上，会话就永久卡死。现在：

- `scheduleWakeV2` 的繁忙分支也写 `pendingSince`（看门狗兜底）。
- 新增 `tryRecoverStuckBusyV2()`：立刻探一次 DSH 会话是否真空闲 / turn 标记是否已过期，
  是就**当场清标记并直接投递**，不用让群友白等 8 分钟；探针异常一律按「仍繁忙」处理，
  绝不把唤醒弄丢。
- turn/end 的补发判据从 `seq >= item.seq` 改成**精确匹配自己那条 seq**
  （`pendingWakeStillRelevantV2`）：卡死恢复后队列里常积压 20 条旧意图，
  用 `>=` 会每回合结束补一刀、连叫十几次。

> 想确认是不是这类卡死：看 `state/social-v2.json` 里该会话的 `pendingSince`——
> 若是 0 而 `pendingWakeReasons` 非空，就是本文说的这种。

### Q：AI 说「视频我这边打不开」（聊天里发的 QQ 视频）？

以前确实打不开：`extractMediaFromSegments` **整段忽略 `video` 段**，AI 只看到一行 `[视频]`，
只能靠文字猜（线上实例：有人发视频 +「蕾姆醒了」，AI 回「视频我这边打不开，不过这四个字信息量就够了」）。

现在：

- 视频段会被记成 `kind: 'video'`（带 `file` / `url`，网关不给封面时就没有 `thumb`），
  消息提示里直接给出工具与参数，AI 不用猜。
- 工具 `qq_get_message_video(key, messageId, token, frames=1~8)`：桥接把视频抓下来，
  用 ffmpeg **抽几帧**（有 duration 就均匀取；拿不到就用 `thumbnail` 滤镜挑代表性帧），
  缩到 `frameMaxWidth` 再以图像返回给视觉模型，同时给出时长/分辨率/体积。
- 单独一个端点 `/api/images/message-video`：抽帧要下载整条视频 + 跑 ffmpeg，慢且重，
  必须是 AI 明确要看的动作，不能顺带在每条带媒体的消息上做。
- **抓视频不能用 `safeFetchBuffer`**：它强制校验「必须是 PNG/JPEG/GIF/WebP」，mp4 会被
  「抓取内容不是有效图片」直接拒掉（实现时真踩到了）。为此加了 `safeFetchBinary()`——
  只放开格式校验，SSRF 校验/体积上限/超时/逐跳重定向校验与 `safeFetchBuffer` 完全一致，
  回归用例见 `scripts/test-audit-security.mjs`。
- **抽帧需要本机有 ffmpeg**：`apt-get install -y ffmpeg`，或把 `socialV2.video.ffmpegPath`
  指到可执行文件（填 `none` 可显式关掉抽帧、只给封面）。找不到时接口如实返回
  `hasFfmpeg:false` + 装法，不会假装看到了。
- **没有语音转写**：本机没有 ASR，视频里说的话 AI 听不到，只看画面。工具返回与提示词都
  反复强调这一点（否则模型很容易顺口编台词）。要听内容只能让群友打字，或视频本身是 B 站链接
  （那种可以用 `qq_video` 读字幕）。

配置在控制台「二代仿真模式 → qq_get_message_video 的 ⚙」或 `config.json` 的 `socialV2.video`：
`maxBytes`（抓取上限，超过就用封面）、`maxFrames`、`frameMaxWidth`、各超时。

### Q：AI 看不懂动图（GIF），或者抱怨「图糊了 / 拳头糊成一颗球」？

两个独立的坑，都在图片归一化那条链上（`fitMediaBuffer` / `normalizeImageForVision`），
先拿真字节复现再改：

**坑一：透明底被压成黑底。** `sharp(...).jpeg()` 丢掉 alpha 时，透明区的 RGB 就是 0，
也就是**纯黑**。透明底贴纸一过这条链，深色的手臂、袜子、描边全部和背景糊在一起，
只剩浅色部分浮着。线上原话就是「第三张那拳头糊成一颗球了」——白色拳头留在黑底上，
深色手臂消失了。复现很简单：

```js
const { data } = await sharp(pngWithAlpha).jpeg().raw().toBuffer({ resolveWithObject: true });
// 原本 rgba(0,0,0,0) 的角落，压完变成 rgb(0,0,0)
```

现在**有 alpha 的图走 WebP（保透明）**，退到 PNG，最后兜底才压 JPEG 且**压白底**
（`flatten({ background: '#ffffff' })`），绝不使用默认黑底。

**坑二：动图只取第一帧。** `sharp(buf, { animated: false })` 只解第一帧，
于是一个 27 帧的点头动图在 AI 眼里就是一张静止的蹲姿照片，笔记也跟着写歪。
更隐蔽的是：小于 1.5MB 的动图会**原样透传**（`image/gif`），AI 同样只看到第一帧。

现在 `normalizeImageForVision` 会先 `probeImageMeta` 看 `pages`：

- 静态图 → 1 张，走原来的压缩阶梯；
- 动图（`pages > 1`）→ 等间隔抽 `VISION_ANIM_FRAMES`（默认 4）帧，
  每帧 `512px` WebP（保透明），并带上「动图第 k/n 帧（原图共 N 帧，按顺序播放）」的文字标注。

配套三件事，缺一个就会退化成老行为：

| 位置 | 作用 |
|---|---|
| `qq_get_message_images` / `qq_get_sticker_image` | 一条媒体返回多张图，每张前面带「第 k/n 帧」文本锚点 |
| `mediaHintFor` 与唤醒提示 | 提前说明「动图会返回多帧，别只看第一帧就下结论」「多帧是同一个表情，不是你发了好几张」 |
| `qq_collect_sticker` | 收藏走 `fetchOneBotImageRaw` 拿**原始字节**，不再把动图重编码成单帧静图存进 QQ |

真机验证（`/api/socialV2/sticker-image`，stickerId 指向 27 帧的 `兔耳蹲着`）：

```
frameCount: 4
frame 0: image/webp 25278 bytes | 动图第 1/4 帧（原图共 27 帧，按顺序播放）
frame 1: image/webp 20036 bytes | 动图第 2/4 帧（原图共 27 帧，按顺序播放）
...
```

> 附带发现：这次修复顺带查出 `state/stickers.json` 里有笔记是**照着第一帧写的**，已经写歪
> （`超时空辉夜姬_扭腰` 被写成「白毛生气脸，适合炸毛怼人」，实际是半眯眼微笑在扭腰）。
> 遇到这种就按多帧重新写一遍笔记——现在工具会一次给全帧，重写成本很低。
> 当前收藏里 78 个表情中 14 个是动图，重跑一遍笔记值得。

回归测试：`scripts/test-audit-bridge.mjs` 的「透明图片压缩后不能变成黑底」
（断言透明角落的 alpha 仍为 0 且不是 JPEG）、「动图抽多帧投喂，不再只给第一帧」
（内嵌一份 2 帧 GIF，断言抽出的首末帧不同）、「媒体提示要提醒可能是动图」、
「唤醒提示要说清多帧是同一个表情」。

### Q：AI 把表情包当图片，还回「这张图你发第二遍了 / 图库存重了」？

根因是**桥接把网关给的身份丢了**。QQ 对图片段是这么标的：

| 类型 | 字段 |
|---|---|
| 普通图片 | `sub_type: 0`、`summary: "[图片]"` |
| QQ 动画表情（表情包） | `sub_type: 1`、`summary: "[动画表情]"` |

但 `extractMediaFromSegments` 只读驼峰 `d.subType`（网关是下划线 `sub_type`，恒为空），
喂给 AI 的 `safeMedia` 又只保留 `kind/file/url/faceId`，于是**一律显示 `[图片]`**。
线上表现：玄真连发同一个动画表情三次，AI 把它当照片，回了「？这张图你今天发第二遍了，P图库是不是存重了」。

现在：

- `imageSegmentLabel()` 统一判定，消息文本里表情包显示 `[动画表情]`（普通图仍是 `[图片]`）。
- `safeMedia` 带上 `label` / `subType` / `summary`，AI 在未读列表里就能分清。
- 媒体提示会直接写「表情包是反复用的，不要指出『你发过了/重复了/存重了』」。
- 唤醒提示每轮加一条【表情包可以重复】，并禁止 AI 提自己的图库/素材来源。
- `qq_get_message_images` 的返回也逐项标「图片 / 表情包」。

> 注意：修复前已经入库的旧消息，其 `media` 里没有这两个字段，无法回溯补标（网关当时给
> 的 `summary` 已被丢弃）；新收到的消息才带得上。

### Q：AI 说「图我这边没取到 / 看不到图」（手机直出的大照片）？

以前会：QQ 图片超过 4MB 就被桥接直接丢掉，AI 只回一句「取不到」。线上实测一张
4.35MB 的月饼照片连发三张都看不到，日志是 `图片超过大小限制（4194304 字节）`。

现在的行为是**先抓下来、本地压缩再投喂**：

- 抓取硬上限 `MAX_MEDIA_FETCH_BYTES`（16MB）：这个范围之内的原图都先拿到本地。
- 超过投喂上限 `MAX_MEDIA_BYTES`（4MB）时用 `sharp` 压：长边 ≤1600，质量 82→68→72→66→60
  逐档降，直到落回 4MB 内；成功会记一行 `图片已本地压缩后投喂（4450KB → 397KB）`。
- 未超限的图**原样返回**，不重编码（保住透明 PNG / 动图，也不白费 CPU）。
- 像素上限 `MAX_MEDIA_PIXELS`（6400 万）交给 `sharp.limitInputPixels` 兜底，图片炸弹会解码失败被跳过。
- 压缩只服务「看得见」，画质必然下降；要原图请走别的通道。

### Q：AI 说「图片站点不在白名单里」，存不了我或群友发的表情包？

这是 AI 用错工具 + 旧白名单太窄共同造成的，已经修好：

- 聊天里别人发的图/表情，正确工具是 `qq_collect_sticker(messageId=那条消息)`：
  它让网关用 `get_image` 重新取字节，**不受 `socialV2.image.refererAllow` 限制，也不怕 `rkey` 过期**。
- AI 手里只有 `media.url` 时，那张图通常挂在腾讯自家 CDN（`multimedia.nt.qq.com.cn` 等）上。
  现在这些域名已进默认 `refererAllow`，`qq_save_sticker` 也走得通了（兜底）。
- 顺带修了一个老问题：原来「命中白名单就无脑发 `imageReferer`」，会把 B 站的 Referer
  发给腾讯图床、可能被判盗链；现在只有 `socialV2.image.refererHosts`（默认 `hdslb.com`/`bilibili.com`）
  里的图床才带 Referer。
- 被拒时的报错会直接告诉你/告诉 AI 该改用哪个工具，不再是干巴巴一句「不在白名单内」。
- 判定逻辑在 `src/image-allow.js`，离线单测见 `scripts/test-stickers.mjs`（`## 图片来源白名单`）。

### Q：AI 说「我点进去了，但正文抓不到」（前端渲染的分享页）？

这不是桥接抓取失败，是页面本身**纯前端渲染**。实测小黑盒分享链接：
302 之后拿到的 HTML 只有 2698 字节，`<body>` 里就一个 `<div id="app"></div>`，
没有 og: description、没有 SSR 文本 —— 去掉脚本后可见文本只有「小黑盒 - 玩家高能聚集地」11 个字。
纯 HTTP 抓取（`web_fetch`）**不可能**拿到正文，只有真浏览器执行 JS 才行。

能做和已经做的：

- **把失败变得可读**：`web_fetch` 现在返回 `text`（已剥离脚本/标签的正文候选）、
  `meta`（title/description/og:description）、`jsonLd`，以及 `renderHint`。
  识别到空壳页面时会明确写「疑似前端渲染（SPA）：剥离脚本后可见正文只有 N 字」，
  并直接给出三条出路：① 用 `web_search` 搜标题拿摘要；② 试站点开放 API（分享接口常返回 JSON）；
  ③ 请对方截图或复制正文。**别反复重试同一个 URL**。
- **判定宁可漏报不误报**：光看「正文短」会把短公告误判成 SPA，所以要求**同时**满足
  「可见正文 < 80 字」和「有前端渲染特征（空 SPA 挂载点 / ≥2 个 script）」。
- **JSON-LD 兜底**：SPA 页面常带 `application/ld+json`，里面的 headline/description/articleBody
  往往能救一命，会一起抽出来并附在 `renderHint` 里。
- 纯函数在 `src/html-text.js`，单测 `npm run test:html-text`。

**彻底解决：`web_render`（无头浏览器渲染）**

真正需要执行 JS 才能拿正文的页面（小黑盒、部分小红书/抖音分享页）现在可以读了：

```
web_render(url, settleMs?) → { rendered, text, meta, jsonLd?, renderHint?, elapsedMs }
```

实测小黑盒那条分享链接：**7.2 秒**渲染完成，正文、评论区、相关推荐全部拿到。
`web_fetch` 的 `renderHint` 在检测到 SPA 时会**首推** `web_render`。

因为本机内存只有 1.6G（embedding 模型常驻 186MB），这个功能是按「内存优先」设计的：

| 措施 | 说明 |
|---|---|
| 懒启动 + 空闲关闭 | 渲染完 **60 秒**没人用就关掉浏览器；实测净增约 135MB，关闭后完全释放 |
| 同一时刻只渲染一个页面 | 并发两个 SPA = 两个 renderer 进程，直接串行化 |
| 可用内存闸门 | 低于 **220MB** 直接拒绝渲染（明确报错），宁可这次失败也不拖垮桥接 |
| 禁图/禁字体/禁媒体 | 只要正文；`--blink-settings=imagesEnabled=false` |
| 限制 renderer/堆 | `--renderer-process-limit=1`、`--js-flags=--max-old-space-size=128` |
| **出网走过滤代理** | 见下 |

**安全边界（重要）**：桥接控制台（`:3100`）、DSH（`:3080`）、OneBot（`:3000`）都在本机，
把任意外部页面的 JS 放进真浏览器里跑，不管住网络就是 SSRF。所以 `web_render` 的
Chromium 带 `--proxy-server` 指向 `src/safe-proxy.js` 起的本地过滤代理：

- 所有出网流量（含子资源、重定向、**WebSocket**）都过代理；
- 代理对每个目标 `resolveSafeHost` 解析并校验，命中内网/本机/云元数据地址直接拒；
- **连的是校验通过的 IP 而不是域名**，堵掉 DNS rebinding 的窗口。

用 `puppeteer` 的 request 拦截做不到这一点：`page.on('request')` 管不到 WebSocket 握手，
而且应用层拦截漏一条路径就是漏洞。

依赖说明：`puppeteer` 放在 `optionalDependencies`（含 ~150MB Chromium），装不上时
`web_render` 不注册、`renderHint` 自动退回「搜标题 / 请对方截图」的建议，主程序不受影响。
单测：`npm run test:browser-render`（含代理 SSRF 边界 + 本地假 SPA 渲染）。

### Q：AI 能刷贴吧吗？（贴吧按 IP 风控）

**能刷一部分，另一部分刷不了**，这是百度按 IP 风控的结果，不是桥接的问题。实测（2026-09，本机 IP）：

| 贴吧路径 | 结果 |
|---|---|
| `/hottopic/browse/topicList?res_type=1`（热议榜） | ✅ 200，30 条热榜话题 + 讨论量 + 摘要 |
| `/hottopic/browse/hottopic?topic_id=<id>`（话题详情） | ✅ 200，该话题下相关帖的**标题/摘要/作者/回复数/来自哪个吧** |
| `/f?kw=xxx`（吧列表） | ❌ 403 + 百度安全验证滑块 |
| `/p/xxx`（帖子详情） | ❌ 403 + 百度安全验证滑块 |
| 吧内搜索 / 全吧搜索 | ❌ 403 + 百度安全验证滑块 |

几个试过但**没用**的路子，别再重复踩：

- **`web_render` 无头浏览器**：同样被滑块拦住（`web_render` 拿回来的是「请向右滑动完成拼图」）；
- **先访问 baidu.com 暖 cookie（BAIDUID）**：仍然 403，说明拦的是 IP 而不是缺 cookie；
- **`site:tieba.baidu.com` 搜索**：cn.bing.com 基本忽略 `site:`，返回的都是官网；
- **第三方渲染/抓取代理**（r.jina.ai、rsshub.app）：本机网络不可达（超时）。

所以现在做了两件事：

1. **把「被拦」变得可读**：`web_fetch` / `web_render` 识别到验证页会返回 `accessHint`，
   明确说是「反爬/安全验证拦截」、**换 web_render 也没用**，并给出**能用的入口**
   （热榜 + 话题详情两条 URL，直接可复制使用），而不是把「百度安全验证」当成正文喂给模型。
2. **工具描述里写清可用路径**，AI 不用再靠猜。

**要读具体某个吧的帖子列表 / 帖子详情**（`/f?kw=`、`/p/`），只有配登录态一条路：
给桥接加贴吧 cookie（`BDUSS`），像现有的 B 站 `SESSDATA` 那样注入请求。目前**未实现**——
需要管理员提供 BDUSS（属于账号凭据，要自己权衡）。

单测：`npm run test:html-text`（`## 反爬 / 安全验证页识别`）。

### Q：AI 突然不回话了，日志里一直是「会话繁忙，暂存唤醒原因」？

这是**残留忙标记**造成的，已修（2026-09 线上实际踩过）。桥接判断「会话是否忙」靠几个内存标记
（`v2TurnStartAt` / `collectors` / `promptQueues` / `pendingWakeKeys` / `pendingWakeTimer`）。
如果桥接**在回合中途被重启**、或 DSH 侧回合异常结束导致 `turn/end` 丢失，这些标记会永久残留：
之后每条消息都只换来一句「会话繁忙」，AI 再也不说话 —— 直到 8 分钟看门狗兜底才自愈。

修法：

1. **诊断可读**：`isConversationBusyV2` 拆成 `busyMarkersV2()`，日志直接写出阻塞标记
   （`turn(1523s)+collector` 这种），不用再翻代码猜；`forceClearBusyV2` 也会打印「清掉了什么」。
2. **即时自愈**：唤醒被挡下时先判一次卡死 —— 若阻塞标记只有 turn/collector、
   且 turn 已经跑了超过 `busyRecoveryMs`（默认 8 分钟）、且该会话**不在** `qq_wait_for_messages`
   长轮询里（长轮询是合法的忙，不能打断），就立刻清标记并投递本次唤醒，
   不再干等看门狗下一次 tick。
3. 看门狗仍是最后兜底；回归用例见 `test-audit-bridge.mjs`
   的「stale turn marker is detected as stuck busy and cleared」。

> 运维提示：如果只是想让某个会话立刻醒过来，控制台可用 `POST /api/socialV2/wake {key, reason}`；
> 把桥接重启一次也能清掉全部内存忙标记（代价是内存里还没投递的 `pendingWakeReasons` 会丢，
> 但未读消息是持久化的，AI 醒来看未读照样能接上）。

### Q：AI 说「你发的是张卡片，我这边读不到里面写了啥」？

已修。卡片消息（分享链接、小程序、音乐、群邀请、打卡…）在 OneBot 里是
`json` / `xml` / `share` 三种消息段，桥接原来在 `segmentsToText` 里把它们硬编码成
`[卡片消息]`（`xml` 更是直接掉进 `default` → `[xml]`），标题/摘要/链接全丢。

现在统一走 `src/card-parse.js`，渲染成一句话，例如真实收到的小黑盒分享卡片：

```
[卡片·小黑盒] 姿态975万余额曝光后背景被挖，蓝天幼儿园毕业，小时候上..…；链接：https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_session_id=UKyWyJ6FrOvbQsM9&h_src=YXBwX3NoYXJl&link_id=260c727ab720&new_post_share_style_v2=0；下载小黑盒查看更多精彩内容
```

要点：

- **一个入口全打通**：`segmentsToText` 同时服务二代唤醒上下文、一代 prompt、引用消息解析
  和 `qq_get_message_detail`，所以正文、引用、「@某人 + 卡片」都跟着好了；
- **合并转发也修了**：`forward.js` 复用同一个解析器，聊天记录里的卡片同样可读；
- **链接必须完整（重要）**：摘要把**完整 URL 的优先级放在摘要文字之前**
  （标题+完整链接 → 标题+截断链接 → 只要标题），总长 ≤320 字；
  含卡片的消息在存储时用更大的 text/plain 上限（`CARD_SUMMARY_MAX + 80`），
  普通消息仍是 200 字。原因：把链接截成 `...?h_camp…` 对 AI 等于没有 ——
  它会直接回「链接被截断了，我打不开，你把完整链接发我」；
- **结构化 `card` 字段**：消息对象上另有 `card: { kind, source, title, desc, url, preview }`，
  其中 `url` / `preview` **不做摘要级截断**（上限 1200，足够任何真实链接）。
  即使摘要里实在放不下而截断了，AI 也能从 `card.url` 拿到逐字完整的链接。
  `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` /
  `qq_get_forward_msg` 都会返回这个字段；
- **对方可控内容**：卡片文本会压掉 C0/C1 控制字符、零宽字符与 U+2028/2029 行分隔符，
  单行输出；解析失败会明确写「json 解析失败」，不会假装读到了内容；
- **只提取不执行**：卡片里的 URL 仅作为文本进上下文，桥接不抓取、不跳转；
  AI 想细看可以自己用 `mcp__web-search-safe__web_fetch`（现在链接是完整的，能直接抓）。
- 常见形态：`com.tencent.structmsg`（分享/新闻/视频）、`com.tencent.miniapp_01`（小程序，
  取 `meta.detail_1` + `qqdocurl`）、`com.tencent.music.lua`（音乐）、`com.tencent.tuwen.lua`（图文分享）。
- 单测：`npm run test:card-parse`（含真实卡片 payload 固定样本）。
- **已知限制**：卡片里的预览图（`preview`）目前只提取 URL、不自动下载，
  所以「图为主、文字很少的卡片」AI 只能读到标题；要看得见图需要再扩一条
  「卡片预览图 → 视觉上下文」的通道。



---

*公开版文档，不包含本地开发历史与个人配置。*
