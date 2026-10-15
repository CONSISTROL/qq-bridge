# QQ ↔ DeepSeek Harness 桥接

**English**: [README.en.md](README.en.md) | **中文**: [README.md](README.md)

> 📘 详细内外核说明书见 **[docs/PROJECT_GUIDE.md](docs/PROJECT_GUIDE.md)**（架构、数据流、配置全解、调试与改进指南）。
>
> 🔒 QQ 会话的权限边界与安全承诺见 **[RULES.md](RULES.md)**。

把 QQ 消息接入 DSH agent：QQ 好友/群发来的消息会变成 DSH 会话里的用户消息，agent 的回复（含提问、工具审批）会发回 QQ。

> ⚠️ **当前版本 `v0.1.5`，适配 DSH 0.1.5-rc.1**（在该版本上逐项实测）。使用 Cookie 鉴权、斜杠 RPC 和 `/api/remote.mux` 事件流；这一代协议自 DSH `0.1.2-alpha.1` 起引入，与更早的点号 endpoint 协议不兼容——**DSH `0.1.1-rc.2` 及更早**请改用 tag [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0)。
>
> 默认分支 `main` **就是**本版本，`git clone` 直接拿到，无需切换分支。

```
QQ 消息 ──► SnowLuma（OneBot v11 WS）──► 本桥接进程 ──► DSH Web API (127.0.0.1:3080/api)
                                                ▲                      │
                                                └── agent 回复/提问/审批 ┘
```

## 项目展示

📽️ [AI 仿真群友 - 项目介绍视频](https://github.com/Derpyu520/qq-bridge/releases/download/v0.1.5/project-intro.mp4)（约 11 MB）

> 视频改由 **Release 附件**托管，不在仓库里——只想安装桥接的人不必再下载这 11 MB（它此前占整个仓库体积的 88%）。

## 架构

- **QQ 侧**：`@snowluma/sdk` 的 `SnowLumaWebSocketClient`（OneBot v11 WebSocket 客户端，自动重连）
- **DSH 侧**：适配 DSH 0.1.2 起、0.1.5 复核通过的协议——launch token 换 Cookie 鉴权、`/api/<namespace>/<method>` 斜杠 RPC、`/api/remote.mux` + `session/follow` 事件流；复用 `AbstractApiClient` 传输层但不再依赖旧版 zod value schema。会话模型由桥接按 `config.json` 的 `dsh.model` 逐会话 `session.selectModel` 固定（默认 `deepseek-flash` = DeepSeek-V41-Flash，多模态）
- **agent 自主收发 QQ**：DSH 的 MCP 客户端（`~/.dsh/profiles/web/cordis.patch.yml` 配置）接入三个 MCP server：
  - `snowluma`（桥接自带 `src/mcp-snowluma-safe.js`）：QQ 动作**安全子集**（查状态/查群/查消息/发消息，发送强制白名单；发送工具支持可选 `replyToMessageId` 引用回复）
  - `snowluma-host`（桥接自带 `src/mcp-host-server.js`）：`snowluma_status`（默认只读探活）；`start_snowluma` / `stop_snowluma` 需显式开启 `snowluma.allowProcessControl: true` 且仅在 `closed-agent` 模式可用
  - `web-search-safe`（桥接自带 `src/mcp-web-search-safe.js`）：只读 `web_search` / `web_fetch`（带 SSRF 防护），供 agent 查网络用语/资料
- **会话模型**：每个 QQ 会话（私聊/群）对应一个独立的 DSH 会话，统一归组到「QQ 聊天」工作区（不再散落未分组）；映射持久化在 `state/sessions.json`
- **机器人自己的资料（昵称 / 个性签名 / 头像）**：AI 可以用 `qq_get_self_profile` / `qq_set_profile` / `qq_set_avatar` 改自己的账号资料，控制台「二代仿真模式」里也有一个资料面板（现状预览、手动改、**一键回滚**、变更记录）。这一项和别的工具不一样——它改的是**账号级身份，全群全私聊可见**，所以默认关，且即使打开也只在「管理员上下文」生效（管理员私聊，或本轮由管理员消息触发；群友在管理员后面接一句不算）。另外还有：内容校验（昵称/签名不许放链接、联系方式、推广字样，不许冒充官方）、每日限流（默认 3 次/天）、旧值留档可回滚（改之前会把当前昵称与当前头像备份到 `state/self-avatar/`）。头像是桥接自己下载后转 base64 交给网关，不把 URL 交给网关抓。网关侧对应 `set_qq_profile` / `set_qq_avatar`
- **主题探索（自主扩展学习）**：控制台「黑话 / 向量检索」页输入一个种子关键词（或 AI 用 `qq_explore_topic` 发起），桥接会在**独立学习会话**里联网把这一圈学回来：先弄清它是什么、里面有哪些梗，再顺着关联主题继续挖（`mygo` → CRYCHIC / Ave Mujica / 夢限大みゅーたいぷ…）。挖到的梗直接进黑话库并生效，主题综述进知识库，之后聊天时自动能吃上。深度与主题总数双上限（`slang.explore.maxDepth` / `maxTopics`，默认 2 层 / 15 个）防关联无限发散；AI 侧另有每小时次数上限。队列/预算/去重/解析容错在 `src/topic-explore.js`（纯函数，可单测），编排与落库在 `src/bridge.js`。实测一次 `mygo` 探索：15 个主题、180 条梗，含「卖狗」「母鸡卡 / 鸡团」「为什么要演奏春日影」这类真实黑话
- **工作车道（长任务并行）**：DSH 的一个会话同一时刻只跑一个 turn，所以慢工具（pixiv 取图链上限 110s、十几 MB 的图发送、B 站视频）会把整条 QQ 会话堵住——用户在这段时间里问什么都得等它跑完。桥接为此给每个 QQ 会话额外开**独立的「工作车道」会话**：AI 用 `qq_run_task` 把整条长任务投进去，**立即返回**，聊天会话马上就能继续接别的话；工作车道用同一套 preset 与 `qq_*` 工具（所以它能自己把图发出去），跑完把结论回投给聊天会话，由主 AI 决定怎么跟群友说。`config.json` 的 `socialV2.work`（`enabled` / `maxSessions`，默认 2 条车道）控制开关与并行度，超出上限的任务排队但仍不阻塞聊天。车道会话随聊天会话一起退役/归档，控制台「工具」行有开关与 ⚙ 参数
- **性格定制**：QQ 会话默认使用 `qq-chat` agent preset，`reserved2` 使用 `qq-chat-v2`；源文件在仓库 `dsh/agent-presets/<id>/agent.cordis.yml`，由 `scripts/setup-dsh.mjs` 安装——DSH 0.2+ 装成 profile 里的 `@deepseek-ai/dsh-agent-preset` 插件行，DSH 0.1.x 装到 `~/.dsh/.agent-presets/<id>/`；人格与默认 DSH 一致（coding agent），仅附加 QQ 场景规则；**角色扮演**是可选机制——由控制台或管理端设置 `state/current-role.json` 注入（群友无法更改）
- **本地控制台**：桥接自带 Web 控制台 `http://127.0.0.1:3100`——切换运行模式（chat / closed-agent / reserved / reserved2）、设置角色、静默开关、查看活动日志、修改管理员/控制台令牌，全部即时生效；访问需要令牌（`config.json` 的 `consoleToken`，未配置时自动生成并打印在启动日志；控制台内可手动修改或重新生成）。**令牌只需输入一次**：验证通过后桥接会给这个浏览器记一个 HttpOnly Cookie（30 天），之后刷新/重新打开都不再要求输入，控制台内可「忘记本机令牌」
- **AI 记忆管理**：控制台左侧「AI 记忆」分区把 AI 的记忆收成一个可管理的入口——七类记忆（会话记忆 / 群成员备注 / 对话上下文与转录 / 黑话库 / 群知识库 / 收藏表情笔记 / DSH 侧长期记忆文件）各有多少条、约吃多少 token；能逐条改删、**钉住**重要的（批量清空与自然遗忘都会跳过）、按规则**自然遗忘**，并在任何破坏性操作前自动**备份、可一键回滚**；页面上还有「下次唤醒时 AI 会看到什么」的原文预览。详见 `docs/PROJECT_GUIDE.md` §5.6
- **AI 图片管理**：控制台左侧「AI 图片」分区管的是 AI 从网上抓下来、落在本机的图——本地图库（`assets/stickers`）、pixiv 抓取样例（`state/pixiv-picks`）、B站视频帧缓存（`state/video-cache`）、**AI 发出去的网络图**（`state/sent-images`，发图/存表情时顺手落一份，以前只留在内存里、事后根本找不回来）各有几张、占多少盘，缩略图网格里能看图、搜索、逐张删、按来源清空，也能按「保留天数 / 总容量上限」**自然清理**；**删除一律先进回收站**（`state/image-trash/`，能整批或逐张还原，图库索引条目一起还原），确认不要了再彻底删除。改动之前发出去的图用「**补抓历史发过的图**」从会话记录与桥接日志里重新捞回（后台任务 + 进度显示）。控制台专属（带 agent token 一律 403），路径穿越与指向目录外的软链都会被拒。详见 `docs/PROJECT_GUIDE.md` §5.8
- **入站内容策略（越线请求不让 AI 思考）**：`config.json` 的 `moderation` 段让这类请求**在进模型之前**就被桥接拦下——消息不进未读、不触发唤醒、不写进会话上下文，由桥接自己回一句固定短话（或静默）；AI 连「发生过这件事」都不知道，也就不会为它花一次推理。词表/正则、动作、回复文本、同会话冷却都可配；**默认词表是空的**（要拦什么由管理员显式写），因为 `萝莉`/`合法萝莉`/`ロリ`/`loli`/`正太` 这类是 pixiv 上的正常 ACG 标签，请求它们就是普通搜图，该不该发由 `socialV2.image.rating` + `ratingWords` 决定。详见 `docs/PROJECT_GUIDE.md` §5.7
- **运行模式**：
  - `chat`：白名单群 + 白名单私聊 → qq-chat 安全聊天
  - `closed-agent`：仅私聊 owner（config.json 的 ownerQQ，可在控制台设置）→ 完整工具（默认用 DSH 自己声明的默认 preset，即 `standard`；可在控制台「closed-agent preset」下拉改为任意 DSH preset），可在 QQ 上操控 DSH
  - `reserved`（一代仿真）：仿真群友，观望/活跃/试探/退场状态机，选择性参与、按空格分句发送、主动收尾
  - `reserved2`（二代仿真，运行 `setup-dsh.mjs` 后 DSH 默认）：文本不自动转发，AI 通过 `qq_get_unread_messages` / `qq_send_message` 等工具自主看消息、发言、等待、设置唤醒/潜水；DSH 端使用 `qq-chat-v2` preset
- **交互增强**：
  - agent 通过 `ask_user_question` 提问时，问题会转发到 QQ，回复即自动应答
  - agent 请求工具审批时，转发到 QQ，回复「通过」/「拒绝」即可决策
  - 支持 DSH 斜杠命令（如 `/model`）与 `/reset`（重置会话上下文）
  - 群聊引用/回复会解析成「被引用人 + 原文」注入 DSH（如 `[引用 Derp：El Psy Kongroo是啥]机关的走狗`），让 AI 判断这句话是对谁说的，不会把群友之间引用第三方的对话误当成指向自己；引用机器人自己时会被视为必回
  - MCP 发送工具支持可选 `replyToMessageId`，并新增专用 `qq_reply` 工具：AI 可以先用 `qq_get_group_history` 拿到真实消息 id，再引用/回复某条消息（是否允许 AI 主动使用由人格/策略决定；桥接会检测发送类工具调用并自动跳过该回合的重复自动转发）
  - **链接分享卡 `qq_send_card`**（⚠️ **当前网关协议版本下渲染不出来，AI 侧默认关闭**：QQ 客户端显示「发送者版本过低，无法展示内容」。消息本身被正常接受——`message_seq` 有值、网关侧卡片体完整——门禁在 QQ 的**发送端协议版本**上，桥接改不了。要分享链接请直接用 `qq_send_message` 发「标题 + 完整链接」。以下是功能本身的说明，换到支持的协议版本后控制台打开开关即可）：把一条链接分享成 QQ 那种带标题/摘要/缩略图的卡片。**AI 只能填字段，卡片体（`com.tencent.structmsg` / `news`）由桥接组装——不做任意 `json`/`xml` 透传**：卡片体是网关侧的任意结构化内容，能伪造「系统通知 / 红包 / 群邀请」这类看着像官方的东西，群里点开就是外部跳转，所以只开放这一个固定形状。链接与缩略图必须是**公网 `http(s)`**（本机/内网地址一律拒绝，否则提示注入能让 AI 发一张指向本机控制台、还带着令牌的可点击卡片）。实际渲染由 QQ 客户端决定，老版本可能只显示兜底文本「[分享] 标题 + 链接」，所以卡片自带的 `prompt` 里始终有完整链接。开关与长度/频率/主机白名单在控制台「工具」行 ⚙
  - 一代仿真模式（`reserved`）下，AI 可以只输出 `[SILENT]` 表示“潜水/不接话”，桥接会静默不发送
  - 一代仿真模式（`reserved`）按空格分句：AI 用空格表示拆成多条消息；中英文/数字之间的空格也会被当成分条信号，不想分条就不要加空格（`reserved2` 不适用，分条请用 `qq_send_message` 数组）

## 前置条件

1. 运行中的 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）
2. 运行中的 SnowLuma，且配置好 OneBot WebSocket 与 HTTP API（默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，`accessToken` 视配置填写）
3. Node.js ≥ 22.13

## 安装与配置

```bash
npm install        # 安装依赖（postinstall 会自动修补 @snowluma/sdk 的 ESM 打包 bug）
```

复制 `config.example.json` 为 `config.json` 后编辑：

> Windows CMD 用户请用：`copy config.example.json config.json`

> ⚠️ 真实 `config.json` 与 `state/` 不会进入公开仓库，仓库只提供脱敏的 `config.example.json` 模板。

| 字段 | 说明 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080` |
| `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` | DSH 会话使用的模型/推理强度；若你的 DSH 没有示例中的模型，改成 DSH 设置页里可用的模型即可（选择失败只打日志，不阻塞启动） |
| `dsh.authToken` | DSH launch token（新版 DSH 用于换取 Cookie 的进程启动 token）。留空时桥接会自动从 `~/.dsh/guard/logs/server-*.out.log` 发现；DSH 重启后遇到 401 也会自动重新发现并换 Cookie。⚠ 自动发现**只认日志里那行带 `?token=` 的启动横幅**：启动 DSH 的 `script` 若没加 `-f`（flush），横幅会卡在 4KB 块缓冲里不落盘，于是发现逻辑只能退到**更早一次启动的旧 token**，还会把内存里正确的覆盖掉 → 永久 401 且不再自愈。本机的 `dsh-restart.sh` 已改成 `script -qf` 并轮询抓取（2026-10-11 踩过：16:43~23:11 桥接整体哑了 6.5 小时） |
| `dsh.authHeader` / `dsh.authPrefix` | 保留字段，当前新版 DSH 链路使用 Cookie 交换，不再直接发送该鉴权头 |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** 地址（如 `ws://127.0.0.1:3001`） |
| `snowluma.httpUrl` | OneBot **HTTP API** 地址（如 `http://127.0.0.1:3000`）；不要填 WebSocket 端口，否则会报 HTTP 426 |
| `snowluma.accessToken` | OneBot accessToken，未配置留空 |
| `snowluma.launcherPath` / `homeDir` | SnowLuma 启动脚本与安装目录（供 agent 自动启动/停止） |
| `agentPreset` | QQ 会话使用的 DSH agent preset，默认 `qq-chat`（改性格见下文） |
| `socialV2.agentPreset` | `reserved2` 模式使用的 DSH agent preset，默认 `qq-chat-v2` |
| `workspaceTitle` | QQ 会话在 DSH 界面中的归组名称，默认「QQ 聊天」 |
| `allow.private` / `allow.groups` | 白名单（QQ 号/群号数组）；留空且 `allowAllWhenEmpty: true` 时放行全部 |
| `deny.*` | 黑名单，优先于白名单 |
| `ackMessage` | 消息投递后的立即回复，空字符串关闭 |
| `sendDelayMs` | QQ 连续发送间隔，防止触发频率限制 |
| `consolePort` | 本地控制台端口，默认 `3100` |
| `consoleToken` | 控制台访问令牌；留空时启动自动生成并保存到 `state/console-token` |

> ⚠️ `allowAllWhenEmpty: true` 表示「白名单没填就全部放行」——把 agent 接入 QQ 等于把账号控制权交给了模型，建议先填白名单。

### DSH 端安装（必做：装 preset + 挂 MCP）

桥接和控制台能跑起来还不够，DSH 端还需要安装两个聊天 preset（`qq-chat` / `qq-chat-v2`）并挂载 MCP。**单机新装同样必须执行这一步**（不是只有「另一台设备」才需要），装完还要**重启 DSH**：

```bash
node scripts/setup-dsh.mjs
```

> 全新环境下脚本会把 DSH 默认模式设为 **`reserved2`（二代仿真）**，并创建本地 `state/mode.json` 兜底；这样 AI 使用 `qq_send_message` 等工具收发消息时，DSH 会自动使用 `qq-chat-v2` 模式。如果本机已存在旧的 `state/mode.json` 或 DSH 设置值，脚本会保留不覆盖。之后可在**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部按钮切换模式，控制台会同时写入 DSH 设置与本地兜底文件。

详细步骤见 **[docs/DSH_SETUP.md](docs/DSH_SETUP.md)**。

## 完整启动流程（从零开始）

共 6 步。DSH 已安装并运行，缺的是 SnowLuma 本体 + 桥接侧的 DSH 端安装（**第 2、3 步最容易漏，漏了 QQ 上会毫无反应**）：

1. **DSH**（已运行，无需操作）
   确认 `http://127.0.0.1:3080` 能打开即可。

2. **装桥接并复制配置**
   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   npm install
   ```
   Windows CMD 用 `copy config.example.json config.json`，其他平台用 `cp config.example.json config.json`。
   **示例模板里 `allow.private` / `allow.groups` 是空数组**——空白名单 + `allowAllWhenEmpty: false` 时桥接不响应任何消息（这是刻意的 fail-closed 默认值）。白名单在第 5 步填。

3. **装 DSH 端（preset + MCP），然后重启 DSH**
   ```bash
   node scripts/setup-dsh.mjs
   ```
   装完**必须重启 DSH**——preset 与 MCP 只在 DSH 启动时加载。
   跳过这步桥接不会崩，但群聊会话拿不到 `qq-chat` preset，桥接会**拒绝建会话**（有意的安全设计：绝不回退到带 bash/文件工具的默认 preset），表现同样是 QQ 上没反应。

4. **下载并解压 SnowLuma**
   - 下载：<https://github.com/SnowLuma/SnowLuma/releases/latest> 选 `SnowLuma-v<版本>-win-x64.zip`（完整版，自带 Node 运行时；Lite 版需本机 Node 22.13+）
   - 解压到任意目录（例如 `C:\SnowLuma`），双击 `launcher.bat`

5. **首次引导（WebUI）+ 填写桥接配置**
   - 打开启动日志里的 WebUI 地址（README 写的是 `http://localhost:5099`，以你启动日志里实际打印的为准）
   - 用**启动日志中的初始密码**登录，按引导：同意条款 → 设置密码 → 接入 QQ 进程（扫码登录）
   - 在 WebUI 里配置 OneBot 连接：开启 **WebSocket 服务端** 和 **HTTP API**，分别记下**端口**（默认 WS `3001`、HTTP `3000`）和 **accessToken**（若配置了）
   - 回到 `config.json` 填好 `snowluma` 段，并把 `allow.private` / `allow.groups` 换成**你自己的 QQ 号 / 群号**：

     ```json
     "snowluma": {
       "wsUrl": "ws://127.0.0.1:3001",
       "httpUrl": "http://127.0.0.1:3000",
       "accessToken": "你在 WebUI 里配置的 token（没配置就留空）"
     }
     ```

   `wsUrl` 是 OneBot **WebSocket** 端口，`httpUrl` 是 OneBot **HTTP API** 端口（不要填成同一个 WS 端口，否则 MCP 工具会报 HTTP 426）。

6. **启动桥接**
   ```bash
   npm start          # 前台运行（崩溃不自动重启）
   ```
   看到 `SnowLuma 已连接` 即成功；然后 QQ 上给机器人账号发条消息测试。
   想要「崩溃自动重启」请用守护脚本：Windows `start.bat`，Linux/macOS `./start.sh`（见下节）。

## 运行与运维

```bash
npm start          # 前台运行，崩溃不自动重启（等价于 node src/bridge.js）

# Windows
start.bat          # 守护模式：崩溃 5 秒后自动拉起；窗口别关
restart.bat        # 杀旧实例 → 清锁 → 重开守护窗口

# Linux / macOS（与上面两个 .bat 语义一致）
./start.sh         # 守护模式（前台；Ctrl+C 退出）。后台跑：nohup ./start.sh >state/bridge-run.log 2>&1 &
./restart.sh       # 停旧守护+桥接 → 清锁 → nohup 后台拉守护（./restart.sh --fg 则前台）
./stop.sh          # 停止守护与桥接、清理单实例锁
./status.sh        # 看守护/桥接 PID、锁、控制台端口、最近日志
# 也可以走 npm：npm run start:guard / npm run restart / npm run stop / npm run status
```

**⚠️ 重要**：
- **桥接只能运行一个实例**（有单实例锁，重复启动会被拒绝并提示"已有实例在运行"）
- **想让它崩了自动回来，就用守护脚本**：Windows `start.bat` / Linux `start.sh`（都设 `QQ_BRIDGE_GUARDED=1`）。直接 `node src/bridge.js` 或 `npm start` 都是前台单进程，崩了不会自己回来。
- 桥接异常/消息无反应时：Windows 双击 `restart.bat`；Linux/macOS 跑 `./restart.sh`（都是「杀旧实例 → 清锁 → 重开守护」）。
- **控制台的「重启桥接」按钮在三种情形下都可用**：守护模式（`start.bat` / `start.sh` 设了 `QQ_BRIDGE_GUARDED=1`）只让进程退出、由守护 5 秒后拉起；手动 `node src/bridge.js` / `npm start` 没有守护，桥接会自己 detached 拉一个新进程（约 1 秒）再退出——以前这种情况按一下按钮就永久下线。
- **重启 DSH 通常不需要动桥接**：每 5 秒探活，DSH 不可用期间收到的 QQ 消息在桥接进程内排队（最多 50 条/会话，满后丢最旧项），恢复后尝试补投。桥接进程退出会丢失内存队列；断线期间已经结束的回复暂不保证补发。
- 修改 `config.json` / `roles/` / `state/current-role.json` 后重启桥接生效；修改 `~/.dsh/.agent-presets/qq-chat*/` 或 MCP 配置后重启 DSH 生效
- **改了 preset 文本（`dsh/agent-presets/qq-chat*/agent.cordis.yml`）后**：先 `node scripts/setup-dsh.mjs` 同步到 DSH（DSH 0.2+ 写进 profile 的 `cordis.patch.yml`，由 HMR 热加载；0.1.x 复制到 `~/.dsh/.agent-presets/`），再**重启桥接**。DSH 只在建会话时读一次 preset（`agent-preset/locked`），桥接会比对每个会话的 preset 组成戳，发现文件变过就让该会话退役、下条消息按新 preset 重建（`socialV2.presetRefresh: false` 可关掉，改为保留旧上下文）。所以不必为了改预设重启 DSH，也不会再出现「改了预设、群里照旧」。
- **DSH 大版本升级后 preset 失效**：DSH 0.2 起 `dsh-agent-preset-registry` 不再扫描 `~/.dsh/.agent-presets/`，preset 必须声明成 profile 的插件行。症状是群里完全没反应、`state/bridge.log` 反复出现「preset "qq-chat-v2" 不在 DSH 可用清单」。跑一次 `node scripts/setup-dsh.mjs` 即可（脚本会自动识别 0.1.x / 0.2+；判定不准时用 `QQ_BRIDGE_DSH_PRESET_FORMAT=modern|legacy` 强制）。

日志示例：

```
12:00:01 [bridge] SnowLuma 已连接：ws://127.0.0.1:3001
12:00:02 [bridge] 新会话 private:12345678 -> sess_xxxx
12:00:02 [bridge] 已投递 private:12345678: 你好
12:00:20 [bridge] agent 回复 (private:12345678) 42 字
```

## 自测（不需要 SnowLuma / QQ）

离线回归（使用临时目录和模拟服务，不读取真实配置、不发 QQ 消息）：

```bash
npm run test:audit
```

单模块自测（隔离实例 + 假 OneBot，不碰真实 QQ）：

```bash
npm run test:member-remarks
npm run test:card-parse
npm run test:html-text
npm run test:browser-render   # 需要 Chromium（optionalDependency），没装则自动跳过
```

本轮审查与修复明细见 [docs/AUDIT_REPORT_2026-09-18.md](docs/AUDIT_REPORT_2026-09-18.md)。升级后会为没有权限元数据的历史映射重建一次 QQ 会话；模式或 preset 变化也会自动重建，避免保留旧权限。旧历史仍在 DSH 中。

验证 DSH 侧链路是否打通（会创建一个独立测试会话，不影响现有会话）：

```bash
npm run self-test
```

预期输出：连接成功 → 测试会话创建 → prompt 被接受 → 打印 agent 回复。

## 目录结构

```
qq-bridge/
  config.example.json   # 配置模板（脱敏占位符；真实 config.json 不入库）
  docs/
    PROJECT_GUIDE.md    # 公开版项目说明书
  dsh/agent-presets/    # qq-chat / qq-chat-v2 的 DSH agent preset 模板
  plugins/qq-mode-console  # DSH 插件：注册 qq-mode 设置命名空间（仅 host 半，UI 卡片未实现）
  src/
    bridge.js           # 主程序
    dsh-client.js       # Node 版 DSH API 客户端（WS 下行）
    md-to-plain.js      # Markdown → QQ 纯文本
    self-test.js        # DSH 侧自测
  scripts/              # 测试/运维脚本（含 postinstall 的 patch-snowluma-sdk.mjs）
    patch-snowluma-sdk.mjs  # 修补 SDK 的 ESM 打包 bug（postinstall 自动执行）
  state/                # 运行时数据（不入库）
```

## 已知限制

- agent 回复在回合结束时一次性发送（不做流式逐字转发）；回复超过 4000 字自动分段
- **一个 QQ 会话的「聊天」仍然一次只跑一个 turn**：工作车道解决的是「慢活挡住整条会话」，但同一个会话里两句话仍然按顺序处理（这是 DSH 会话模型的固有行为）。工作车道需要 DSH 重启一次才会出现在工具列表里（MCP server 是 DSH 启动时拉起的子进程）
- **大图发送依赖 WS 通道**：base64 图片走 WS，写类动作的等待上限按 payload 体积放宽（约 512KB/s 估算，上限 180s）。超时**不再回退 HTTP 重发**——超时不等于失败，盲目重发正是重复发图的历史根因；此时桥接会如实返回「发送结果不确定」，并临时挡住同一张图的自动重试
- **文字消息发送失败时会去历史里求证，不让一次网络抖动变成两条重复消息**：写类动作只要**可能已经送出去**（回执超时、连接中途断开、HTTP 传输中断）就**绝不回退重发**（那是重复的直接来源），改为用 `get_group_msg_history` / `get_friend_msg_history` 查这条到底发出去没有——**查到**就当已送达（按成功返回，模型不会重发）；**确认没有**才如实报失败（这时重发是安全且正确的）；**查不了**才带 `uncertain` 标记，MCP 侧返回**非错误**结果并劝阻「不要原样重发，先用 `qq_get_recent_messages` 确认」。只有「网关明确回绝」和「连接还没建立就失败」这两种确定没发出去的情况才会回退 HTTP 重试
- **主动开口不会老是同一套（记忆 + 语义查重两道）**：① **记忆**——桥接记着最近 20 次「你主动开的头」（`proactive.rememberOpeners`），最近 4 条原样摆出来，更早的带「X 小时前 / N 天前」压缩成清单（线上「耳虫」就是隔两天又开了一次，而上下文窗口只给最近 20 条消息、模型根本看不到自己说过）；**自己说过的话（含回复）另有一份 `selfSaid` 记忆**（`proactive.rememberSelfSaid`，默认 40 条，带 `kind=opener/reply`）——因为线上踩过：同一话题先在**回复**里讲过（电车服务区充电），5 天后又当新话题开了一遍，而旧记忆只覆盖主动开盘那一轮；旧状态没有这份记忆时会在载入时**从已有发言一次性补种**，不用等几天才生效。同时**具体点名**重复的起头方式（连着几次都用「刷到个…」）与重复题材（连着几次都是健康作息冷知识）——模型只会觉得「午睡 ≠ 久坐」，不点名它就会一直「合规地」复读。② **语义查重闸门**——主动开口的第一条先跟最近 7 天的 `selfSaid` 比向量相似度（用常驻的中文模型，实测同话题 0.83 / 不同话题 0.32~0.47，默认阈值 0.75，`proactive.repeatSimThreshold`）：太像就**直接不发**，把「和你 N 天前那句几乎一样（相似度 0.xx）」连同原句打回让模型换题（每轮只拦一次，避免卡死）。方向池也不再纯随机：最近几轮建议过的方向、以及正在重复的题材对应的方向都先避开（`proactive.domainCooldown`，默认 2 轮）
- 图片及部分表情可以通过安全下载接入多模态模型；一条消息里图很多时按每批 5 张分批返回（`qq_get_message_images` 传 `imageOffset` 翻页，返回里会写明「本条共 N 个、本次给了第几到第几」）——线上踩过：7 张图被截成 5 张，AI 没有翻页手段，只会在群里说「后两张我被吞了没看着」。**图片有「投喂安全区」**：`socialV2.image.passthroughBytes`（默认 1.5MB）与 `softPixels`（默认 2.5MP）**两个维度都卡**，安全区内原样投喂、超出才本地重编码（**从 4096px 往下试**、二分定位）。别只看 DSH 的准入（20MB/64MP）就放宽：DSH 内部读大图会爆栈——线上把阈值放宽到 8MB 后，一张 7.4MB/4096x3072 的图直接让模型收到「image unavailable: Maximum call stack size exceeded」（4MB 预算内尽量用高分辨率；先按「源图字节/像素」估个上界跳过注定塞不下的大档，再二分定位，日志会写「→ 长边 N，源 WxH」）——线上踩过：同一张痛车图私聊原样投喂看得清车身上的字，群里抓到 7.5MB 原图却被阶梯顶端 1600px 压成 482KB，AI 只能说「糊成一团认不出来」。**动图按帧数自适应抽帧**（>40 帧抽 6 帧，短的 4 帧），每帧标注都写明「稀疏抽样：单帧里的抬手/眯眼/背身可能只是动作过渡，别据此断言情绪」——线上踩过：143 帧的表情包只抽 4 帧，收尾的「抬手遮脸」被读成「哭图」，AI 跑去调侃群友「拿我形象做哭图」，被当场纠正「图里的大肥鱼没有哭」。语音/视频以及无法取得图片字节的消息仍使用占位文本
- **DSH 重启后要让桥接能重新认证**：DSH 的 launch token 是**进程内随机生成、不落盘**的，只在启动横幅里打印一次（且要等插件树 settle，实测约 97 秒）。桥接靠读 `~/.dsh/guard/logs/server-*.out.log` 里最新的 token 自动发现，所以**手动重启 DSH 时要把输出写进那个目录**：用 `bash scripts/start-dsh.sh`（等价于 `script -q -c "dsh web" ~/.dsh/guard/logs/server-$(date +%F-%H%M%S).out.log`）。事件流遇到 401 也会自动重新发现令牌重连。
- **能读聊天里发的文件（PDF / 文本）**：群友发 PDF 问「这里面讲了什么」时，桥接把它下下来本地解析——有文字层的用 `pdftotext -layout` 抽正文（保留排版、CJK 正常，**默认不限字数**：`socialV2.file.maxTextChars=0`），**扫描件**（没有文字层）用 `pdftoppm` 渲染前几页交给视觉模型；纯文本文件直接读。工具是 `qq_get_message_file`（消息里出现 `[文件 xxx.pdf]` 时调用）。下载上限 `socialV2.file.maxBytes`（默认 50MB）。注意：**不能把 PDF 本体塞给模型**——DSH 的图片/附件通道只认 PNG/JPEG/WebP/GIF，所以必须在桥接侧解析；依赖本机装 `poppler-utils`（`apt-get install -y poppler-utils`）
- agent 的 Markdown 回复会转成纯文本（链接保留 `文字 (url)` 形式）
- **消息读给 AI 时会标明「谁在跟谁说话」**：工具返回的每条消息带 `who`（谁说的，机器人自己标成「你（机器人）」）、`repliesTo`（这条在回谁）、`aboutYou`（**只有 @ 了你或引用了你的消息才有**，没有这个字段＝没针对你）；唤醒提示也把内部原因翻成人话——`speaker:kafka` → 「你关注的群友发言了，**不是在跟你说话**」、`keyword:x` → 「不等于在跟你说话」。入站时会记下 `atSelf`（@ 了机器人本人或 @全体）。线上问题是：这些信息原来都没有，模型把群里每句话都默认当成对自己说的
- `@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，本仓库通过 postinstall 补丁修复（见 `scripts/patch-snowluma-sdk.mjs`）
- 网关没有「群成员本地备注」接口：AI 的成员备注由桥接自己存在 `state/member-remarks.json`（只在 AI 视角生效）；真·群名片 `qq_set_member_card` 默认关闭，且需要机器人是管理员/群主
- 前端渲染（SPA）的分享页（小黑盒/小红书等）用 `web_fetch` 拿不到正文，需要 `web_render`（无头浏览器，`puppeteer` 在 optionalDependencies，约 150MB Chromium）。它按内存优先设计：空闲 60 秒自动关闭、同一时刻只渲染一个页面、可用内存低于 220MB 直接拒绝；页面内 JS 的出网流量全部经过本地过滤代理（`src/safe-proxy.js`），碰不到本机控制台/DSH/OneBot

## 合规提醒

SnowLuma 是独立第三方项目，与腾讯/QQ 无隶属关系，仅供学习与技术研究；使用前请阅读其 EULA 与《QQ 用户协议》。
