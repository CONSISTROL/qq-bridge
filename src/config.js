// 配置加载与校验。
//
// 从 bridge.js 抽出来：原来 loadConfig 与它的默认值常量占了 600 多行，
// 和「桥接运行时」混在一个文件里。现在配置只依赖纯函数与本仓库的小模块，
// 可以单独阅读、单独测试。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSafe } from './json-store.js';
import { discoverDshLaunchToken } from './dsh-client.js';
import { DEFAULT_MILD_TAGS, DEFAULT_TOLERATED_TAGS } from './image-rating.js';
import { STICKER_LIBRARY_SOURCES, STYLE_KEYWORDS } from './sticker-picker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');


// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
export function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
export function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}


// ── 配置 ────────────────────────────────────────────────────────────────────
export function loadConfig(root = ROOT) {
  // QQ_BRIDGE_CONFIG 只用于本地测试：让隔离实例跑另一份配置（端口/状态目录都分开），
  // 不必为了验证一处改动去动线上 config.json。
  const override = String(process.env.QQ_BRIDGE_CONFIG ?? '').trim();
  const p = override ? path.resolve(root, override) : path.join(root, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      // 研究出释义后是否自动转正。开 RAG 后**默认关闭**：
      // 语义检索会主动高频召回，LLM 编错的释义会被推到相关对话里，人工闸门的价值上升。
      // 打开即回到「研究完就能用」的省事模式。
      autoConfirmResearched: false,
      // 豆包网页版：给梗考究多加一路来源（另一个模型的说法）。
      // 它是**模型不是知识库**，所以只在异步考究链里当佐证，单独一路永远不转正
      // （见 src/doubao-research.js 的 decidePromotion）。
      doubao: {
        enabled: false,          // 默认关闭：要先扫码登录、且它吃内存
        profileDir: '',
        memoryMax: '900M',
        memorySwapMax: '1500M',
        idleCloseMs: 5 * 60 * 1000,
        timeoutMs: 90000,
        maxTerms: 3,             // 一轮研究最多问几个词（每个十几秒，且共用一个浏览器）
        budgetMs: 180000         // 一轮豆包取证的硬预算
      },
      // 主题探索（自主扩展学习）：控制台或 AI 给一个种子关键词，AI 自己上网把这一圈
      // 的梗和关联主题学回来。学到的东西自动 confirmed 直接进黑话库/知识库。
      explore: {
        enabled: true,
        maxDepth: 2,          // 关联展开几层（mygo → Ave Mujica → …）
        maxTopics: 15,        // 单个任务最多探几个主题（防关联无限发散烧 token）
        maxJobsPerHour: 6,    // 触发频率上限（AI 也能发起，必须限流）
        maxConcurrent: 1,     // 同时只跑一个任务（学习会话本来也只能串行）
        turnTimeoutMs: 300000
      },
      ...(file.slang ?? {})
    },
    // 群知识库：群友反复问到的客观事实与群内约定/人物，答案沉淀下来避免每次重查重编。
    // 与黑话库分开存储与检索（问题语义空间和词义不同，混在一起会互相挤占注入坑位）。
    knowledge: {
      enabled: true,
      injectMax: 6,           // 每次注入最多几条（比黑话少：答案是长文本，占 context）
      autoWrite: true,        // AI 提交即入库生效（false 时只落候选，等控制台确认）
      remindHitCount: 3,      // 命中次数达到多少时在提示里提醒「这问题已被问过 N 次」
      remindMinAskers: 2,     // 且至少这么多个不同的人问过才算群级 FAQ
      similarityThreshold: 0.62, // 字面近重复合并门槛（越低越容易并成一条）
      conflictMinCosine: 0.8,    // 语义冲突检测门槛：答新旧案差异大且问题相近时标记待裁定
      ...(file.knowledge ?? {})
    },
    // B站能力（黑话研究、图片检索、视频理解都走这里）
    bili: {
      enabled: true,
      videoCacheMB: 200,   // 雪碧图磁盘缓存上限；超了按最久未用淘汰
      ...(file.bili ?? {})
    },
    // AI 图片管理（控制台「AI 图片」分区）：回收站容量 + 可选的受管来源覆盖。
    // 一般不用配，默认管本地图库 / pixiv 样图 / B站帧缓存三个目录；sources 只在
    // 多机部署或测试时用来把某些目录指到别处。
    imageAdmin: {
      trashMaxMB: 500,     // 回收站上限；超了从最旧批次开始丢（0 = 不限）
      sources: [],
      ...(file.imageAdmin ?? {})
    },
    // 本地向量检索（RAG）。缺依赖/模型时自动降级为按出现次数选词，不影响主流程。
    rag: {
      enabled: true,
      topK: 8,
      minFill: 3,          // 相关条目不足时，用本群/全库高频补齐到这个数
      minCosine: 0.5,     // 语义相关门槛（实测校准：全库规模下无关对可到 0.50，故取 0.5）
      relativeMargin: 0.08, // 相对判据：只保留离 top-1 不超过这个距离的条目
      timeoutMs: 1500,     // 单次编码超时；超时就走降级路径，绝不拖慢回复
      weights: { sem: 1.0, conv: 0.15, global: 0.03, recency: 0.05 },
      autoRebuild: true,   // 词条增删改后自动补向量
      // 给 embedder 子进程套 cgroup 内存闸门（本机 OOM 史，实测 190MB 常驻）。
      // 空字符串即关闭。必须带 --quiet，否则 systemd-run 的提示行会污染 stdio 协议。
      spawnPrefix: '',
      ...(file.rag ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat',
      provideRecommendations: true,
      // 掉线补拉：OneBot 是推送模型，断线期间群里的消息网关不会重发
      //（实测 2026-10-05 一次 1006 抖动丢了 5 条，AI 完全不知道它们存在过）。
      // 网关的 get_*_msg_history 支持 count + message_seq 从任意位置往后取，所以能补。
      // 补回来只是拿上下文：**太旧/太多的只入库、不唤醒**，否则等于对陈年旧账刷屏。
      // 出站口播清洗：把「行，」「总结：」这类确定性 AI 标签削掉。
      // 提示词里已经点名禁过「行，」，线上照样出现，这类字符串靠 prompt 压不住，
      // 所以补一层机械清洗（只做删除，不改写；见 src/speech-style.js）。
      style: {
        scrubFormulaic: true,
        ...(file.socialV2?.style ?? {})
      },
      backfill: {
        enabled: true,
        maxMessages: 100,             // 每个会话单次最多补多少条
        wakeMaxMessages: 15,          // 补回来的条数 ≤ 这个值才唤醒 AI
        wakeMaxAgeMs: 10 * 60 * 1000, // 且最早那条不超过这么久才唤醒
        ...(file.socialV2?.backfill ?? {})
      },
      // 工作车道：把一个 QQ 会话的长任务投给独立 DSH 会话跑，聊天会话不被慢工具堵住。
      // maxSessions 是「同时并行几个长任务」的上限，占满后新任务排队（仍然不阻塞聊天）。
      work: {
        enabled: true,
        maxSessions: 2,
        ...(file.socialV2?.work ?? {})
      },
      // 机器人自己的资料（昵称 / 个性签名 / 头像）。
      // **默认关闭**：这改的是账号级身份，全群全私聊可见，群友一句「把你名字改成XXX」
      // 如果真的生效，影响面是它所在的每一个会话；而且 QQ 对频繁改资料很敏感。
      // 打开后也只有「管理员上下文」（管理员私聊，或触发这一轮的是管理员消息）能改。
      profile: {
        enabled: false,
        // 管理员消息的有效期：超过这么久没有再说话，就不算「管理员在场」。
        adminWindowMs: 10 * 60 * 1000,
        minIntervalMs: 10 * 60 * 1000,   // 两次改动之间至少隔多久
        maxPerDay: 3,                    // 每天最多改几次（账号级身份，收紧）
        allowLinks: false,               // 昵称/签名里是否允许链接（默认不允许：广告位滥用）
        maxAvatarBytes: 5 * 1024 * 1024,
        ...(file.socialV2?.profile ?? {})
      },
      // 链接分享卡（qq_send_card）：AI 只能填标题/摘要/链接/预览图，卡片体由桥接组装。
      // 不做任意 json/xml 透传，卡片能被用来伪造「系统通知/红包/群邀请」，风险比纯文本高。
      //
      // 注意：`enabled` 是「功能可用性」，`tools.sendCard` 是「要不要给 AI 用」。
      // 二者分开是有意的：当前网关协议版本下 QQ 客户端显示「发送者版本过低，无法展示内容」，
      // 所以 AI 侧默认关；但保留控制台自测路径，换到支持的协议版本后可随时打开。
      card: {
        enabled: true,
        maxTitleChars: 60,
        maxDescChars: 90,
        maxPerMinute: 5,
        maxPerHour: 30,
        // 空 = 允许任何**公网** http(s) 主机（内网/本机地址始终被 validateFetchUrl 挡掉）。
        // 填了就只允许这些 host（域名后缀匹配，例如 example.com 也放行 a.example.com）。
        allowHosts: [],
        ...(file.socialV2?.card ?? {})
      },
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
      knowledge: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        saveSticker: true,
        sendImage: true,
        listImageLibrary: true,
        searchImages: true,
        // 注：工具开关真正生效的深度合并在下面 cfg.socialV2.tools 那一块（新开关加在那里）。
      video: true,             // B站视频：搜视频 / 读字幕（一个工具两个用法）
      videoFrames: true,       // 按时间点取画面（进度条预览帧）
        getMessageVideo: true,   // 聊天里的 QQ 视频：抽帧给视觉模型看
        getSelfImage: true
      },
      // 从外部来源保存表情（qq_save_sticker）。默认只允许本地图库/base64，
      // 远程 URL 需显式把 allowRemoteUrl 设为 true（会带来出网下载，谨慎开启）。
      image: {
        enabled: true,
        allowRemoteUrl: false,
        libraryDir: 'assets/stickers',
        maxBytes: 5 * 1024 * 1024,
        // 单张图「原样投喂」上限（默认 8MB）：以内的图不再本地重编码，交给 DSH 归一化；
        // 超过才压到这个值以内。调小 = 更省上下文但更糊，调大 = 更清晰但更费内存/带宽。
        passthroughBytes: 1536 * 1024,
        softPixels: 2500000,
        maxPerMinute: 5,
        maxPerHour: 30,
        // 防重复发图窗口（毫秒）：同一张图（按 pixiv 作品 id / URL 身份）在这段时间内不再发第二次。
        // 既会从搜图结果里滤掉，也会在 qq_send_image 时直接拒绝。0 = 关闭。
        repeatGuardMs: 6 * 60 * 60 * 1000,
        // 图片年龄分级：safe=只给全年龄（默认）；mild=允许轻度擦边（水着/黑丝/大腿等标签）。
        // explicit（限制级）在任何档位都不返回，且**只由 explicitExtra 判定**：
        // 内置标签表与标题兜底都已被有意清空（见 src/image-rating.js 的设计说明），
        // 也就是说默认配置下不会自动判 explicit，rating 也改不动这一点。
        rating: 'safe',
        // 分级词表（控制台「图片 / 表情来源（含搜图分级）」可改）：
        //   mild          判为擦边、safe 档会滤掉的词
        //   tolerated     明确划为全年龄的词，优先于 mild
        //   explicitExtra 限制级词（可增；写进 mild/tolerated 也删不掉）
        ratingWords: {
          mild: [...DEFAULT_MILD_TAGS],
          tolerated: [...DEFAULT_TOLERATED_TAGS],
          explicitExtra: []
        },
        // 允许抓取的目标站点 origin；imageReferer 只发给 refererHosts 里的图床
        // （B 站图床有防盗链；QQ/腾讯图床带了 Referer 反而可能被拒）。
        refererAllow: [
          'https://i0.hdslb.com', 'https://i1.hdslb.com', 'https://i2.hdslb.com',
          // QQ 聊天里收到的图片/表情就挂在腾讯自家 CDN 上，AI 拿到的 media.url 通常是这些域名。
          'https://multimedia.nt.qq.com.cn', 'https://multimedia.qpic.cn',
          'https://gchat.qpic.cn', 'https://c2cpicdw.qpic.cn', 'https://p.qpic.cn',
          'https://q1.qlogo.cn', 'https://tianquan.gtimg.cn',
          // pixiv 系：pixiv.re 按作品 id 取原图；img.pixivdaily.com 是榜单镜像的缩略图
          // （原图超 maxBytes 时用它兜底，一张几十 KB）；i.pximg.net 是 pixiv 官方原图 CDN。
          'https://pixiv.re', 'https://i.pixiv.re', 'https://img.pixivdaily.com', 'https://i.pximg.net'
        ],
        refererHosts: ['hdslb.com', 'bilibili.com'],
        imageReferer: 'https://www.bilibili.com',
        // 真实 pixiv（搜索走 ajax 接口、原图走 i.pximg.net）。本机直连 pixiv 不通，
        // 必须填一个可用的 http 代理；R-18 搜索还需要管理员自己的登录 cookie（PHPSESSID）。
        pixiv: {
          enabled: false,
          proxy: '',
          cookie: ''
        }
      },
      // 排队超过该时长就强制清空忙标记并补投（0 = 禁用看门狗）
      busyRecoveryMs: 480000,
      wake: { ...DEFAULT_WAKE_CONFIG },
      send: {
        burstEnabled: true,
        // 放宽到 24：复杂任务（分析/查资料后的结论/给方案）本来就需要把一件事讲清楚，
        // 原来的 8 条上限会让 AI 半路被 429/400 打断。闲聊仍由提示词约束在 1~3 条。
        burstMaxMessages: 24,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        // 这两个是「防刷屏」的硬闸门，不是「回答长度」限制。
        // 但太紧会直接把长回答打断（一个 20 条的回复会撞上每分钟 8 条），所以一起放宽。
        maxSendPerMinute: 30,
        maxSendPerHour: 300,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        burstHintThreshold: 10,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。',
        // 原样重发闸门：把「一模一样的话再发一次」在发送侧直接拦掉。
        // 线上事故：WS 掉线丢了回执 → 桥接明确让模型别重发 → 模型 24 秒后照发，
        // 群里出现两条「一天念那么多字，电费你出啊」。劝不住，只能硬拦。
        // 只拦**自己发过的原文**：复读群友的话不受影响。
        dupGuard: {
          enabled: true,
          uncertainWindowMs: 300000, // 上一条回执不确定：5 分钟内不许原样重发（它可能已经在群里）
          sentWindowMs: 5000,        // 上一条确认送达：只挡 5 秒内的恶性重复调用
          ...(file.socialV2?.send?.dupGuard ?? {})
        }
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        },
        // 表情包「时机判断 + 选图」（qq_pick_sticker + 唤醒提示里的时机门）
        pick: {
          enabled: true,               // 时机判断/推荐总开关
          hintInPrompt: true,          // 是否把「此刻适不适合发表情」写进唤醒提示
          autoUseOnGoodMoment: false,  // true=时机判定为 good 时自动帮 AI 挑好图并附上可直接发送的参数
          minIntervalMs: 90000,        // 两次表情之间的硬冷却（毫秒）
          maxPerTurn: 1,               // 单个回合最多发几张表情
          minScore: 30,                // 本地候选低于该分视为「不满足」，触发联网兜底
          defaultLimit: 5,             // 默认返回候选数
          includeLibrary: true,        // 本地图库（assets/stickers）是否参与候选池
          onlineFallback: true,        // 本地不满足时是否联网找图
          onlineCount: 6,              // 联网返回候选数上限
          styleKeywords: [...STYLE_KEYWORDS], // 联网搜索的风格偏置词
          seedHome: true,              // 联网高分候选是否自动存进本地图库（越用越准）
          librarySources: [...STICKER_LIBRARY_SOURCES], // 参与候选的图库来源（bili-cover/dynamic 这类资讯图不算表情）
          libraryMaxSide: 2600,        // 图库候选的最长边上限（像素）
          libraryMaxRatio: 2.0,        // 图库候选的长宽比上限（挡手机长截图）
          libraryMaxBytes: 3 * 1024 * 1024
        }
      },
      // 三层记忆（第二级档案 + 第三级全量归档）；第一级是 DSH 会话上下文，不用配。
      memory: {
        archive: { enabled: true, keepDays: 90, maxFileBytes: 64 * 1024 * 1024 },
        diary: { enabled: true, hour: 4, maxTurnsPerDay: 1 }
      },
      // 相册：聊天里 AI 看过的图会落一份到 state/album-inbox，和本地图库/pixiv/视频帧/发送记录
      // 一起进控制台的「相册」（元数据在 state/album-meta.json）。关掉就不落盘，只临时读。
      album: {
        enabled: true
      },
      // 语音合成（发语音条）：文本 → edge-tts → RVC 变声（默认 aiyi 音色）→ QQ record 段。
      // 服务跑在 tzd（RVC + torch + 模型都在那台 8 核机器上），协议见 scripts/tts-server.py。
      tts: {
        enabled: true,
        url: '',                  // 例如 http://10.8.0.2:8766/tts
        token: '',                // 与服务端 TTS_TOKEN 一致
        voice: 'zh-CN-XiaoxiaoNeural', // edge-tts 音色（RVC 会把它换成目标音色）
        model: 'aiyi',            // RVC 模型（assets/weights/aiyi.pth）
        transpose: 0,             // 变调半音，调音色高低
        maxChars: 0,              // 0 = 不硬拦；>0 时超长自动截断（不是拒绝）。分寸交给提示词
        cooldownMs: 0,            // 0 = 不设硬冷却；>0 才会拦（owner 要求不要硬门限）
        timeoutMs: 180000
      },
      // 聊天里收到的 QQ 视频：AI 原来只能看到一行「[视频]」，回一句「打不开」。
      // 这里把视频抓下来抽帧给视觉模型看（抽帧要 ffmpeg；没装则退化成封面缩略图）。
      // 注意：**不做语音转写**，本机没有 ASR，视频里说的话 AI 听不到，只看得见画面。
      file: {
        enabled: true,              // 聊天文件（PDF/文本）读取总开关
        maxBytes: 50 * 1024 * 1024, // 文件下载上限（owner 要求 50M；QQ 群文件常见几 MB 到几十 MB）
        maxPages: 4,                // 扫描件最多渲染几页（都是图片，很费上下文）
        renderDpi: 110,             // 扫描件渲染分辨率（高了更清楚也更占体积）
        maxTextChars: 0,            // 0 = 不限（owner 要求不要字数限制）；>0 才截断
  toolChunkChars: 40000,      // 工具每次取多少字（略低于 DSH 修剪阈值 50000，避免中间被剪掉）
        timeoutMs: 60000            // pdftotext / 下载的单步上限
      },
      video: {
        enabled: true,             // QQ 视频理解总开关
        maxBytes: 32 * 1024 * 1024, // 视频抓取上限（超了不下载，改用封面）
        maxFrames: 6,              // 最多抽几帧（均匀分布；每帧都进模型上下文，别贪多）
        frameMaxWidth: 800,        // 抽出来的帧缩到多宽（长边）
        frameQuietMs: 0,           // 预留：帧之间的最小间隔（0=按时长均分）
        ffmpegPath: '',            // 留空=自动找（config → ffmpeg-static → PATH）
        // 语音转写（ASR）：视频里说的话，用一个外部服务转成文字（本机 2 核/460MB 跑不动，放 tzd）。
        // 协议见 scripts/asr-server.py：POST wav 字节 → {ok,text,tookMs}。url 为空＝不转写。
        asr: {
          enabled: true,
          url: '',                  // 例如 http://10.8.0.2:8765/transcribe
          token: '',                // 与服务端 ASR_TOKEN 一致
          lang: 'zh',
          maxSeconds: 180,          // 只转前 N 秒（转写很吃 CPU，长视频别整段转）
          timeoutMs: 180000
        },
        probeTimeoutMs: 20000,     // 解析时长/分辨率的上限
        frameTimeoutMs: 30000,     // 单帧抽取上限
        totalTimeoutMs: 90000      // 整次抽帧的总预算
      },
      // 合并转发（聊天记录）里的图片：默认一次给视觉模型 8 张，AI 可以带 imageOffset 翻页继续取。
      // 以前是写死 5 张，一条几十张图的转发 AI 只能看到前五张、而且不知道后面还有。
      forward: {
        imageLimit: 8,             // 单次返回几张图（AI 不传 imageLimit 时的默认值）
        maxImageLimit: 20,         // 单次硬上限（AI 传再大也压到这个数；一次塞几十张会炸上下文）
        // 单次批总量预算：原来沿用「单条消息 4MB」，手机照片一张 ~1MB，第 5 张起就被丢，
        // AI 于是以为转发里只有 4 张图。现在给更大额度，且撞额度时先压小而不是整张丢掉。
        maxTotalBytes: 16 * 1024 * 1024,
        // 文本层：本层给多少条 / 每条多少字（AI 可用 offset/limit 翻页继续读）
        messageLimit: 50,
        messageChars: 500,
        // 嵌套（合并转发里再套合并转发）：默认往下展开 2 层。
        // 原来只抓一层、每个只给 3 条×120 字，线上那条内层 18 条的记录 AI 只看得到 3 条，
        // 表现就是「多层转发只看得见最外面一层」。
        nestedDepth: 2,
        nestedMessages: 12,        // 第一层嵌套每个给多少条
        nestedDeepMessages: 8,     // 更深的嵌套每个给多少条
        nestedChars: 300,          // 第一层嵌套每条多少字（更深的折半）
        maxNestedForwards: 10,     // 每层最多展开几个嵌套转发
        nestedFetchBudget: 20      // 整次请求最多再抓几条嵌套（防「转发里套转发」指数放大）
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3,
        // ── 主动开话题的「反重复」────────────────────────────────────────
        // 问题：主动开话题时模型能抓的抓手只有「人格 + 群里最近聊的事 + 它自己写的
        // 记忆（activeTopics）」，人格里没写兴趣，记忆里全是最近那个圈子（实测是
        // 电竞/赛事），于是每次主动开口都是同一个话题，群里看着像复读机。
        // 这里记下最近几次「你主动开的头」，下一轮原样摆给它并要求换方向；
        // 再从 domains 里随机点几个方向，给它一个不同于近期记忆的抓手。
        rememberOpeners: 20,       // 记住最近几条主动开的话题（0 = 不记）；20 条才够覆盖「隔天又来一遍」
        rememberSelfSaid: 40,
        openerChars: 120,          // 每条记多少字（太长会挤占上下文）
        suggestDomains: 3,         // 每次随机点几个方向（0 = 不点）
        domainCooldown: 2,         // 最近几轮建议过的方向先避开（0 = 纯随机，实测容易连抽同类）
        repeatGuard: true,         // 主动开口前做语义查重（拿常驻向量模型比最近的盘），太像就不发
        repeatSimThreshold: 0.75,  // 查重阈值：实测同一话题 0.83、不同话题 0.32~0.47
        repeatWindowHours: 168,    // 只跟最近这些小时内的盘比（0 = 不限）
        avoidKeywords: [],         // 主动开话题时明确别碰的词（例如 ["LOL","英雄联盟","S16"]）；留空 = 不限制
        domains: [...DEFAULT_PROACTIVE_DOMAINS]
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    // 主题探索：给一个种子关键词，AI 自己上网把这一圈的梗和关联主题学回来。
    exploreTopic: true,
    // 机器人自己的资料（昵称/签名/头像）：**默认关**。改的是账号级身份，全群全私聊可见，
    // 且群友一句「把你名字改成XXX」就能间接操控，必须管理员显式打开，且只在管理员上下文生效。
    setProfile: false,
    // 链接分享卡（qq_send_card）：只发桥接自己组装的固定形状卡片，不支持任意 json/xml。
    // **默认关闭**：实测当前网关协议版本下，QQ 客户端收到 structmsg 卡片只显示
    // 「发送者版本过低，无法展示内容」这个占位气泡（消息本身被正常接受、message_seq 有值，
    // 是 QQ 侧按**发送端协议版本**做的渲染门禁，桥接改不了）。发出去看着像坏了，
    // 所以默认不给 AI 用；管理员可以在控制台 ⚙ 里打开自测（控制台路径不受这个开关限制）。
    sendCard: false,
    // 工作车道：把长任务投给独立会话跑，聊天会话不被慢工具堵住（这一步是真正生效的深度合并，
    // 上面 tools 默认块里的同名项会被这里的 ...(cfg.socialV2.tools ?? {}) 覆盖）。
    runTask: true,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.proactive 同样要深度合并：config.json 里只要存在 proactive 段（哪怕只写了
  // enabled/probability），外层 spread 就会把**整段**替换掉，新增的默认值会静默消失，
  // 实测踩过：domains 方向池被吃掉，反重复只记住了「别聊这些」却没有「可以聊什么」的抓手。
  cfg.socialV2.proactive = {
    enabled: true,
    checkIntervalMinMs: 30 * 60 * 1000,
    checkIntervalMaxMs: 90 * 60 * 1000,
    idleThresholdMs: 15 * 60 * 1000,
    probability: 0.3,
    rememberOpeners: 20,
    rememberSelfSaid: 40,
    openerChars: 120,
    suggestDomains: 3,
    domainCooldown: 2,
    repeatGuard: true,
    repeatSimThreshold: 0.75,
    repeatWindowHours: 168,
    avoidRepeat: true,
    avoidKeywords: [],
    domains: [...DEFAULT_PROACTIVE_DOMAINS],
    ...(cfg.socialV2.proactive ?? {})
  };

  // socialV2.wake 深度合并：config.json 里的 wake 是历史全量快照，缺键会把代码默认值弄丢
  // （线上踩过：快照把 recommendedProbability 钉死在 0.05，改代码默认值也不生效）。
  cfg.socialV2.wake = { ...DEFAULT_WAKE_CONFIG, ...(cfg.socialV2.wake ?? {}) };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    // AI 空闲时自己给没备注的收藏表情补备注（控制台「表情包」分区有开关）。
    // 关掉后唤醒提示里不再出现「有 N 个表情还没有任何备注」，已写的备注不受影响。
    autoLabel: true,
    // 自动补时**一轮最多几个**。每张表情图都要进模型上下文，所以默认压得比较小；
    // 嫌慢就调大（上限 6）。
    autoLabelPerTurn: 2,
    // 控制台「让 AI 现在补一批」按钮一次要几个（上限 MANUAL_LABEL_MAX）。
    manualLabelCount: 5,
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // 新版 DSH 的 launch token 每次启动会变；配置里没填时自动从 DSH guard 日志发现。
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  return cfg;
}

/**
 * 主动开话题时可选的「方向池」默认值。
 *
 * 为什么要有一份内置的：主动开口时模型能抓的抓手只有「人格 + 群里最近聊的事 +
 * 它自己写的【进行中的话题】记忆」。人格里通常没写兴趣，记忆里又全是最近那个圈子，
 * 于是它一遍遍开同一个话题（线上表现：每次主动冒泡都是电竞/赛事）。
 * 这里给一批互相拉开距离的方向，随机点几个，逼它换抓手。
 */
// 主动唤醒配置（socialV2.wake）的默认值。
// 为什么提成常量：config.json 里存的是**历史全量快照**，浅合并会让「快照里没有的键」直接丢掉默认值，
// 深度合并又需要一份权威默认值。线上踩过：快照把 recommendedProbability 钉死在 0.05，改代码默认值也不生效，
// 机器人就一路潜水到 0.02，群友以为它死了。
const DEFAULT_WAKE_CONFIG = Object.freeze({
      defaultMode: 'diving',
      preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
      preSleepWaitMs: 300000,          // 默认沉睡前至少等待/观察 5 分钟（后台可调）
      recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
      sleepMinMs: 60000,
      sleepMaxMs: 0,
      recommendedSleepMinMs: 300000,
      recommendedSleepMaxMs: 7200000,
      // 实测（2026-10-13）：推荐值写 0.05 时模型会一路压到 0.02~0.08，群里等于不参与，
      // 群友看到的就是「机器人回到潜水模式了」。给一个有参与感的基准值。
      recommendedProbability: 0.2,
      recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
      recommendedAtMention: true,
      recommendedNameMention: true,
      recommendedQuestion: true,
      recommendedPoke: true,
      recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率**别低于 0.15**（推荐 0.2；线上实测 0.05 会把你自己憋成「潜水模式」，群友会以为你死了，owner 私聊更要保持 anyMessage=true）；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
      batchWindowMs: 8000,
      maxWakePerMinute: 1,
      maxWakePerHour: 12,
      noActionLimit: 3,
      maxWakeConfigReminders: 2
});

const DEFAULT_PROACTIVE_DOMAINS = Object.freeze([
  '科技 / AI 圈的新东西', '生活里的琐事与吐槽', '影视 / 动画 / 番剧',
  '音乐 / 歌单', '游戏（非电竞赛事）', '社会新闻里的小事', '冷知识 / 科普',
  '吃吃喝喝', '摸鱼 / 上班上学', '网上的抽象梗', '运动 / 健身', '睡眠 / 作息'
]);
