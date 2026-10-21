# 鱼群bot权限与安全规则（RULES）

## 运行模式（鱼群bot四模式）

模式由**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部的模式按钮切换，也可直接改 DSH 设置的 `qq-mode` 命名空间；
控制台会**同时**写穿到 DSH 设置与本地 `鱼群bot/state/mode.json`，两者保持一致。
（DSH 设置页目前**没有** `qq-mode` 卡片：该插件只有 host 半，未实现浏览器半。详见 docs/DSH_SETUP.md。）
桥接每 5 秒读取一次；控制台切换立即应用。会话持久化记录创建时的模式、preset 和管理员边界，权限变化时自动撤销旧会话映射和聊天模式 token，并在下次消息到达时重建，避免继续使用旧的高权限 preset。升级前没有这些权限元数据的旧会话也会重建一次，历史仍保留在 DSH。
全新安装运行 `scripts/setup-dsh.mjs` 后，DSH 设置与本地兜底默认均为 `chat`；若已存在 `state/mode.json` 或 DSH 设置旧值，脚本不会覆盖。

| 模式 | 允许通道 | agent preset | 用途 |
| --- | --- | --- | --- |
| `chat`（唯一模式） | 白名单群 + 白名单私聊 | qq-chat | 文本不自动转发，AI 通过工具自主看消息/发言/等待/设置唤醒与潜水 |

> 运行模式只有 `chat` 一种（`chat` / `closed-agent` / `reserved` 已删除）。
> 会话永远挂 `qq-chat`，拿不到就 fail-closed 拒绝建会话 —— **没有任何回落 DSH 默认 preset 的路径**，
> 所以群友永远触不到本地工具。
>
> 注：DSH 0.1.5 已不存在 `router-standard` preset。桥接现在留空表示「用 DSH 默认 preset」，
> 并在启动时读取 `agentPresets/list` 校验；填了不存在的 preset 名会回退到默认值并打警告，
> 绝不会创建出「无 preset」会话（那会被 DSH 套上 `standard`，对 QQ 群是安全回归）。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **管理员（ownerQQ，控制台或 DSH 设置页可配置）** | QQ 群/私聊 | 正常聊天 + **管理命令由桥接硬执行**（不经过模型）：`/role <角色名>` 切人格、`/role off` 清除、`/silent` 静默、`/active` 恢复、`/reset`、`/status`；消息自动带【管理员】标记 |
| **群友** | QQ 群 | **仅正常聊天**。控制词、`/` 管理命令被桥接拦截；静默模式下消息不投递给 agent |
| **管理员** | **桥接控制台**（`http://127.0.0.1:3100`） | **最高权限**：控制模式（控制台顶部模式按钮）、控制角色/静默（写 `state/current-role.json`）、完整 DSH 工具（含本地操作）、查看 QQ 活动日志（`state/qq-activity.log`）、直接打开「QQ 聊天」工作区会话对话 |
| **QQ 会话 agent（chat 模式）** | — | 最低权限面（见下） |

## QQ 会话 agent 的硬边界

1. **无本地工具**：qq-chat / qq-chat 预设不挂载 bash/pwsh、文件读写、子代理、工作流——群友无论如何诱导，agent 物理上无法操作本机。
   - 注意区分两个不同的对象：**本机**（跑 DSH 的服务器）与**域外手机**（见下方「手机远端」一节）。群里 agent 对这两者的工具都不存在——手机工具同样被本节的执行期白名单拦掉。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 三个命名空间下的工具，以及 `ask_user_question` / `todo_write`；其他工具（含 `dev_*` 开发/管理工具）在执行期会被 `qq-tool-restrict.mjs` 拒绝。
   - `mcp__phone__*`（域外手机远端）**同样不在白名单内**，因此群里 agent 拿不到手机工具。真实约束是执行期 guard，而不是「工具没被注册」——所以即使 DSH 侧挂载了 mcp-phone，群聊通道依然拒绝。QQ 动作无禁言、踢人、文件上传下载等管理操作。
3. **只读联网搜索**：`qq-chat` / `qq-chat` 预设已关闭 DSH 内置 `tool-web` 的 `search` / `fetch`，联网统一走 `src/mcp-web-search-safe.js` 提供的 `mcp__web-search-safe__web_search/web_fetch`。不暴露本地文件、命令执行、写操作。
   - ✅ `mcp__web-search-safe__web_fetch` 已做 SSRF 加固：仅 http/https、禁止 localhost/私有 IP/链路本地/CGNAT/带凭据 URL、DNS 解析结果全量校验、每跳重定向重新校验、响应体限量读取。
4. **发送强制白名单**：所有发送类工具（`qq_send_group_message` / `qq_send_private_message` / `qq_send_message` / `qq_send_burst` / `qq_reply` / `qq_send_poke` / `qq_send_sticker` / `qq_send_image` / `qq_send_card` 等）的目标必须命中 `config.json` 的 `allow.groups` / `allow.private`，否则拒绝执行。
   - `qq_send_card`（链接分享卡）**当前网关协议版本下渲染不出来**（QQ 客户端显示「发送者版本过低，无法展示内容」，是发送端协议版本门禁），所以 AI 侧默认关闭；它还额外受一层约束：**卡片体由桥接组装**，AI 只能填标题/摘要/链接/缩略图，不接受任意 `json`/`xml`（否则可伪造「系统通知 / 红包 / 群邀请」这类看着像官方的卡片）；链接与缩略图必须是公网 `http(s)`，本机/内网地址一律拒绝（防止做出指向本机控制台、还带着令牌的可点击卡片）。
4b. **账号级身份默认不可改**：`qq_set_profile` / `qq_set_avatar`（改机器人自己的昵称 / 个性签名 / 头像）改的是**账号级身份，全群全私聊可见**，所以：
   - **默认关闭**（`socialV2.profile.enabled` 必须显式 true），且即使开着也**只在「管理员上下文」可用**——管理员私聊，或触发这一轮的是管理员消息；群友在管理员后面接一句不算（判定见 `isAdminProfileContext`，时间打平时保守判「不算」）；
   - 昵称/签名过内容校验：不许放链接/联系方式/推广字样（默认 `allowLinks: false`）、不许冒充官方/系统、长度上限（昵称 24 字、签名 60 字）；
   - 每日限流（默认 3 次/天）+ 最小间隔（默认 10 分钟）；
   - 每次改动都留历史（谁改的/从什么改成什么）；改之前会先把当前昵称（`get_login_info`）与当前头像（qlogo CDN）在本机备份一份，控制台可一键回滚。
   - 头像是**桥接自己下载**再以 base64 交给网关，绝不把 URL 交给网关去抓。
5. **发送禁令（模型层）**：persona 明确规定只有「管理端明确指示」或「【管理员】标记的明确要求」才可使用发送工具；禁止写"我已回复/消息已发送（message_id）"类汇报。
6. **回复审计（桥接层硬拦截）**：agent 回复文本若包含本机路径（`C:\`、`/home/` 等）或凭据特征（token/password/secret/api key 等）→ **整条拦截不发送**，并告知"被安全策略拦截"。
7. **人格由桥接注入**：角色设定来自 `state/current-role.json` + `roles/<角色>.md`，桥接注入到消息；群友口头要求改角色无效（桥接直接拦截），agent 也无文件工具自行更改。
8. **静默模式**：`current-role.json` 的 `mode: "silent"` 时，群友消息不再投递给 agent（仅记录日志），只有管理员消息可对话。

## 手机远端（mcp-phone）

**这是什么**：一台域外 Android 手机，通过手机主动拨出的反向 SSH 隧道接入本机，
被包装成 MCP server `mcp-phone`（`src/mcp-phone.js`，serverName `phone`）。
agent 由此可以对**那台手机**执行命令，与本机工具是两套相互独立的能力。

**为什么群友用不到**：`qq-chat` / `qq-chat` 的 `qq-tool-restrict.mjs` 执行期白名单里
没有 `mcp__phone__` 前缀，所以群聊通道调用手机工具会被直接拒绝。
只有**不带该限制的 preset**（如 `standard`）才看得到这些工具。
换句话说：手机远端的可达面 = 管理员，不是群友。**这是有意设计，改动前请三思。**

**开关**：`config.json` 里 `phone.enabled = true` 才会挂载（`scripts/setup-dsh.mjs` 条件注册）。
默认关闭，因为它是机器专属能力——没有那台手机、没配隧道的机器上挂载它只会产生必然失败的工具。

**可用工具**：`phone_exec`（执行 shell）、`phone_status`（探活）、`phone_capability`（能力探测）、
`phone_screenshot`、`phone_tap`、`phone_swipe`、`phone_key`、`phone_screen_info`。

**能力边界（实测，2026-10-11，Redmi K50 Ultra / Android 14 / HyperOS）**：
手机以 Termux 普通应用身份（`u0_a194`）运行，因此：

| 能力 | 状态 | 原因 |
| --- | --- | --- |
| 执行 shell / 文件读写 / curl / 出站网络 | ✅ 可用 | Termux 正常能力 |
| 屏幕截图（`screencap`） | ❌ 产出 0 字节 | Android 截屏服务拒绝不受信任的应用 |
| UI 注入（`input tap/swipe/key`） | ❌ `INJECT_EVENTS` 被拒 | MIUI 禁止普通应用注入输入事件 |
| 系统服务（`dumpsys` / `wm`） | ❌ 空输出或 Permission Denial | 需要 `android.permission.DUMP` |

**要拿到 UI/截屏能力必须在手机上授权 root**：在 Magisk / KernelSU 里把 **Termux** 加入已授权应用
（Magisk 只把 `su` 挂进已授权进程的挂载命名空间，所以 Termux 现在**看不到** `/system/bin/su`——
它 PATH 里那个 `su` 只是 Termux 自带的桩程序，会打印 "Termux does not supply tools for rooting"）。
授权后 `phone_capability` 的对应项会转为可用。

**操作手机屏幕时的已知坑**（即使 root 可用也适用）：
- 息屏（`Dozing`）时注入会被**静默丢弃**：不报错、也不生效。操作前先 `phone_screen_info` 确认亮屏并已解锁。
- 锁屏下输入数字必须**逐位、每位间隔数百毫秒**；一次 `input keyevent` 传多个 keycode 会被丢掉。
- 6 位 PIN 输完会自动提交，**不要多按回车**（会退回锁屏）。
- Termux 的 PATH 里没有 Android 系统命令，调用必须写绝对路径（`/system/bin/...`）。
- Termux 环境没有 `/tmp`，临时文件放 `$HOME`。
- `/data/local/tmp` 对 Termux 用户**不可写**，写日志到那里会静默失败。

## 黑话 / 网络用语学习与迭代

- 桥接会把普通群聊消息放入滚动窗口（`state/slang.json` 的候选来源），攒够 `slang.extractMinMessages` 条后交给独立 DSH 学习会话提取“疑似黑话”。
- 候选默认 **不自动转正**：DSH 可联网搜索生成含义/用法/示例，但最终必须由管理员在控制台「黑话管理」里 **确认 / 拒绝 / 编辑 / 删除**。
- 只有 `status: confirmed` 且含义非空的词条会被注入 QQ 聊天 agent 的 prompt（`【群聊黑话表】`），且按出现次数排序、最多 `slang.injectMax` 条。
- 学习会话与 QQ 会话隔离：学习任务的输出不会发到 QQ；它只读消息文本，不执行本地操作。
- 学习会话不会向用户提问/请求审批，桥接会自动跳过这类请求，避免阻塞学习任务。
- `web_search` 工具返回的搜索摘要仅作为候选解释，不视为权威；控制台可随时修改或拒绝。
- 敏感信息/路径/凭据仍走统一审计；黑话库仅存白名单群内消息的文本证据，控制台可删除。

## 管理员操作手册

### 切换角色 / 模式（两种途径，均为硬性机制）

**途径 A：QQ 群内管理命令**（桥接直接执行，不经过模型判断）：
```
/role 小鲸鱼    # 切换角色（roles/小鲸鱼.md）
/role off         # 清除角色
/silent           # 静默模式（群友消息不回复）
/active           # 恢复正常
/status           # 查看会话/白名单/角色/模式状态
/reset            # 重置当前 QQ 会话上下文
```

**途径 B：DSH WebUI**：
- 在 GUI 会话里对我说「给 QQ 机器人设置角色：小鲸鱼」/「清除角色」/「开启静默模式」，我写 `state/current-role.json`
- 或手动编辑 `鱼群bot/state/current-role.json`：
  ```json
  { "role": "小鲸鱼", "mode": "active" }   // active=正常, silent=静默
  ```
- 角色文件放 `鱼群bot/roles/<角色名>.md`（格式见 `roles/README.md`）

### 查看 QQ 活动

- WebUI 里直接打开「QQ 聊天」工作区的会话，可完整查看每次交互（含工具调用）
- 桥接还会把每次收发写入 `鱼群bot/state/qq-activity.log`（最近 500 行），GUI 会话的 agent 可读取汇报

### 在 WebUI 与 QQ 机器人对话

打开「QQ 聊天」工作区里的会话即可直接对话（DSH 原生）。`chat` 不自动转发 agent 文本，但工具可以发送 QQ；`chat`、`reserved` 和 `closed-agent` 会转发映射会话的 agent 回合输出，因此在这些会话中从 DSH 界面输入内容，也可能使回复出现在 QQ。需要纯本地讨论时请使用没有 QQ 映射的 DSH 会话。

## 事故与兜底

- 群友诱导 agent 时，preset 的工具限制和目标白名单是主要硬边界。发送工具仍可能造成白名单内的误发；敏感信息正则属于启发式审计，不能识别任意秘密或保证“最多只发一条”。账号和会话隔离仍需结合实际运行模式使用。
- 想彻底关闭机器人：停止桥接进程（start.bat 窗口 Ctrl+C）或 SnowLuma。
- 修改白名单/角色/owner 后保存即热更新（控制台写入 config.json / state/*.json 后即时生效）；修改 preset（`~/.dsh/.agent-presets/qq-chat*/`）后重启 DSH 生效。
- ⚠️ 桥接只能运行一个实例：消息异常时先检查任务管理器里是否有多余的 `node ...bridge.js`。
