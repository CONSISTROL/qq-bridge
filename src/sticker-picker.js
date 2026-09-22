// 表情包「时机判断 + 选图」纯函数模块（二代仿真模式）。
//
// 职责：
// - 把 QQ 收藏表情（state/stickers.json）与本地图库（assets/stickers/index.json）归一化成统一候选
// - 判断「此刻是否适合发表情包」（冷却、频率、语境、严肃话题抑制）
// - 用轻量文本匹配（中文 bigram + 标签/备注）给候选打分排序，不用模型、不用视觉
// - 本地不满足时，生成带「二次元 / DeepSeek 二创 / 梗图」风格偏置的联网搜索词
//
// 设计原则：
// - 纯函数、无 IO、无副作用：桥接与测试共用，便于单测与调参
// - 打分只是「建议」，最终是否发、发哪张由 AI 决定（桥接只做硬冷却约束）
// - 宁可返回「没有合适的」，也不要硬推一张不相关的图

const CJK_RE = /[\u4e00-\u9fff]/;

/** 去标点、统一小写，保留中英文数字。 */
function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[，。！？、；：""''（）《》【】\[\]{}()<>~`!@#$%^&*_+=\\|/,.?;:'"-]+/g, ' ')
    .trim();
}

/**
 * 轻量分词：ASCII 词（长度≥2）+ 中文 bigram（避免引第三方分词库）。
 * 「笑死我了」→ ['笑死', '死我', '我了', '笑死我了']
 */
export function tokenize(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const out = new Set();
  for (const word of text.split(' ')) {
    if (!word) continue;
    if (CJK_RE.test(word)) {
      if (word.length <= 2) out.add(word);
      else {
        for (let i = 0; i + 2 <= word.length; i++) out.add(word.slice(i, i + 2));
        // 整段保留（长度有限）以提高长词精确匹配价值
        if (word.length <= 6) out.add(word);
      }
    } else if (word.length >= 2) {
      out.add(word);
    }
  }
  return [...out];
}

// 语境 → 意图标签 + 联网搜索词。
// need 是「该语境下真人会发的表情」的自然语言描述，用来和表情备注/标签做匹配。
const INTENTS = [
  { id: 'laugh', words: ['哈哈', 'hhh', '笑死', '笑了', '好笑', '绷不住', '乐了', '草', 'lol', '幽默', '好笑死', '搞笑', '梗', '太草'], need: '大笑 笑死 绷不住', search: ['笑死 表情包', '爆笑 梗图'] },
  { id: 'cry', words: ['哭了', '呜呜', '泪目', '破防', '难受', '委屈', '流泪', '想哭', 'emo'], need: '哭 泪目 破防 委屈', search: ['泪目 表情包', '破防 表情包'] },
  { id: 'angry', words: ['生气', '气死', '怒', '炸毛', '不爽', '烦', '火大', '欠揍', '骂'], need: '生气 炸毛 不爽 怼人', search: ['生气了 表情包', '炸毛 表情包'] },
  { id: 'speechless', words: ['无语', '离谱', '服了', '沉默', '麻了', '逆天', '卧槽', 'wtf', '寄', '6', '抽象'], need: '无语 离谱 麻了 震惊', search: ['无语 表情包', '离谱 表情包'] },
  { id: 'agree', words: ['同意', '赞同', '确实', '对的', '没错', '有道理', '可以', '行', '好耶', '收到', '安排', 'ok', '中'], need: '收到 赞同 好耶 比大拇指', search: ['收到 表情包', '赞同 表情包'] },
  { id: 'praise', words: ['厉害', '牛', '强', 'nb', 'tql', '优秀', '膜拜', '大佬', '太猛'], need: '膜拜 佩服 厉害了', search: ['膜拜 表情包', '牛逼 梗图'] },
  { id: 'tease', words: ['菜', '菜鸡', '就这', '不行', '弱', '捞', '菜狗', '嘲讽', '打脸'], need: '嘲讽 就这 菜 不服', search: ['就这 表情包', '嘲讽 表情包'] },
  { id: 'cute', words: ['可爱', '萌', '好可爱', 'awsl', '心动', '软', '小猫', '猫猫', '狗狗', '仓鼠'], need: '可爱 卖萌 猫猫', search: ['猫猫 可爱 表情包', '萌宠 表情包'] },
  { id: 'shy', words: ['害羞', '脸红', '不好意思', '嘿嘿', '捂脸'], need: '害羞 捂脸 脸红', search: ['捂脸 表情包', '害羞 表情包'] },
  { id: 'shock', words: ['震惊', '啊这', '竟然', '真的假的', '不敢相信', '蛤', '哇'], need: '震惊 啊这 不敢相信', search: ['震惊 表情包', '啊这 表情包'] },
  { id: 'tired', words: ['累', '困', '睡觉', '晚安', '摸鱼', '摆烂', '躺平', '加班', '上班', '班味'], need: '躺平 摸鱼 累 晚安', search: ['摸鱼 表情包', '躺平 表情包'] },
  { id: 'beg', words: ['求', '帮忙', '拜托', '跪', '红包', 'token', '额度', '吃', '饿', '饭'], need: '讨饭 求求 装可怜', search: ['讨饭 表情包', '求求了 表情包'] },
  { id: 'smug', words: ['哼', '傲慢', '得意', '笑死你', '聪明'], need: '得意 傲慢 哼', search: ['得意 表情包', '傲慢 表情包'] },
  { id: 'goodbye', words: ['拜拜', '再见', '溜了', '先走', '下播', '睡了'], need: '拜拜 溜了 再见', search: ['拜拜 表情包', '溜了 表情包'] },
  { id: 'comfort', words: ['加油', '抱抱', '别难过', '安慰', '会好的', '辛苦'], need: '抱抱 加油 安慰', search: ['抱抱 表情包', '加油 表情包'] },
  { id: 'ai', words: ['deepseek', 'ds', '小鲸鱼', '鲸鱼', 'd老师', '大肥鱼', 'ai', '模型', 'token', '算力'], need: '小鲸鱼 deepseek AI', search: ['deepseek娘 表情包', '小鲸鱼 表情包'] }
];

// 严肃/敏感语境：硬抑制发表情包（桥接侧判断，AI 侧策略提示里也写了同一条）。
const SERIOUS_WORDS = [
  '分手', '去世', '死了', '生病', '住院', '手术', '抑郁', '自杀', '事故', '车祸',
  '吵架', '闹翻', '报警', '投诉', '被封', '封号', '违法', '举报', '葬礼', '悼念',
  '面试', '答辩', '考试', '挂科', '离职', '裁员', '欠钱', '借钱', '医院'
];

/** 从上下文文本里识别意图标签（可能多个）。 */
export function detectIntents(text) {
  const t = normalizeText(text);
  if (!t) return [];
  const hits = [];
  for (const intent of INTENTS) {
    if (intent.words.some((w) => t.includes(normalizeText(w)))) hits.push(intent.id);
  }
  return hits;
}

/**
 * 玩笑语境豁免：「笑死」「笑不活了」里的“死”是夸张而不是真事。
 * 不做这层豁免的话，最该发表情的语境反而会被严肃门拦掉（实测踩过）。
 */
const JOKE_PREFIXES = ['笑死', '笑不活', '笑嘻', '笑疯', '笑喷', '乐死', '笑到', '笑出', '好笑到'];

/** 是否属于「不适合发表情」的严肃语境。 */
export function looksSerious(text) {
  const t = normalizeText(text);
  if (!t) return false;
  if (JOKE_PREFIXES.some((p) => t.includes(p))) return false;
  return SERIOUS_WORDS.some((w) => t.includes(w));
}

/** 该语境下是否提到了 AI/自己（用来偏向自己的二创表情）。 */
export function mentionsSelf(text) {
  const t = normalizeText(text);
  return ['deepseek', '小鲸鱼', '鲸鱼', 'd老师', 'd指导', '大肥鱼', '哦鲸鲸', 'ai']
    .some((w) => t.includes(normalizeText(w)));
}

/**
 * 归一化候选（QQ 收藏表情或本地图库条目）→ 统一结构。
 * @param {object} raw
 * @param {'qq'|'library'} kind
 */
export function normalizePickItem(raw, kind = 'qq') {
  const entry = raw && typeof raw === 'object' ? raw : {};
  if (kind === 'library') {
    const file = String(entry.file || '').trim();
    if (!file) return null;
    return {
      kind: 'library',
      ref: file,
      // 本地图库走 qq_send_image(source=library, image=file)，不是收藏表情
      channel: 'image',
      file,
      id: `lib:${file}`,
      title: String(entry.title || '').trim(),
      desc: '',
      localNote: '',
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
      source: String(entry.source || 'library'),
      origin: String(entry.origin || ''),
      width: Number(entry.width) || 0,
      height: Number(entry.height) || 0,
      bytes: Number(entry.bytes) || 0,
      useCount: 0,
      lastUsedAt: 0
    };
  }
  const id = String(entry.id || entry.emoji_id || '').trim();
  if (!id) return null;
  return {
    kind: 'qq',
    ref: id,
    channel: 'sticker',
    id,
    file: '',
    title: '',
    desc: String(entry.desc || '').trim(),
    localNote: String(entry.localNote || '').trim(),
    tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
    source: String(entry.source || 'qq'),
    origin: '',
    width: 0,
    height: 0,
    bytes: 0,
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0
  };
}

/**
 * 图库条目的 index.json 元数据：
 * - origin 是抓图关键词（如「小鲸鱼表情包」），比 B 站评论摘要（title）可靠得多，
 *   所以把「表情包/表情/gif/动图」这类通用词剥掉，只留真正的主题词当匹配锚点。
 * - title 只保留较短、不像口水话的部分（长标题往往是「前来返图！！！」这种噪声）。
 */
export function libraryMetaText(item) {
  const origin = String(item?.origin || '')
    .replace(/表情包|表情|gif|动图|图片|合集|头像/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const title = String(item?.title || '').trim();
  const titleUsable = title.length > 0 && title.length <= 12 ? title : '';
  return [origin, titleUsable].filter(Boolean).join(' ');
}

/** 候选的可匹配文本（备注/笔记/标签/标题/来源关键词）。 */
export function itemText(item) {
  const parts = item?.kind === 'library'
    ? [item?.desc, item?.localNote, libraryMetaText(item), ...(Array.isArray(item?.tags) ? item.tags : [])]
    : [item?.desc, item?.localNote, item?.title, item?.origin, ...(Array.isArray(item?.tags) ? item.tags : [])];
  return parts.filter(Boolean).join(' ');
}

/**
 * 给单个候选打分（0~100）。
 * 组成：文本相关度 55 + 全新度 12 + 稀有度 8 + 来源偏好 5，命中「自己二创」再加 6。
 */
export function scoreStickerItem(item, { contextTokens, needTokens, intents = [], preferSelf = false, now = Date.now(), recentIds = [] } = {}) {
  const ctx = contextTokens instanceof Set ? contextTokens : new Set(contextTokens || []);
  const need = needTokens instanceof Set ? needTokens : new Set(needTokens || []);
  const text = normalizeText(itemText(item));
  const textTokens = new Set(tokenize(text));
  let relevance = 0;
  for (const token of need) if (textTokens.has(token)) relevance += 9;
  for (const token of ctx) if (textTokens.has(token)) relevance += 3;
  // 标签直接包含意图词，额外加权
  const tagText = normalizeText((item.tags || []).join(' '));
  for (const intent of intents) {
    const words = normalizeText(intent.need).split(' ').filter(Boolean);
    if (words.some((w) => tagText.includes(w))) relevance += 8;
    else if (words.some((w) => text.includes(w))) relevance += 4;
  }
  // 完全没文本信息（没备注/没笔记/没标签）的候选给一个中性底分，避免永远选不出来
  const hasText = text.length > 0;
  const base = hasText ? 0 : 6;
  const relScore = Math.min(55, relevance + base);

  const total = Math.max(1, now);
  const hoursSince = item.lastUsedAt ? (total - item.lastUsedAt) / 3600000 : Infinity;
  const freshness = Number.isFinite(hoursSince) ? Math.min(12, Math.max(0, hoursSince / 6)) : 12;
  const rarity = item.useCount <= 0 ? 8 : item.useCount === 1 ? 6 : item.useCount <= 3 ? 3 : 0;
  const sourceBonus = item.kind === 'qq' ? 5 : 3;
  const selfBonus = preferSelf && /小鲸鱼|鲸鱼|deepseek|大肥鱼|哦鲸鲸/i.test(text) ? 6 : 0;
  const recentPenalty = recentIds.includes(item.id) || recentIds.includes(item.ref) ? 25 : 0;
  // 尺寸手感：表情包一般边长 ≤640；一两千像素的长图更像资讯配图/插画，天生不适合当表情发。
  const side = Math.max(Number(item.width) || 0, Number(item.height) || 0);
  const sizeBonus = !side ? 1 : side <= 640 ? 6 : side <= 1000 ? 3 : side <= 1600 ? -4 : -10;

  const score = Math.max(0, Math.min(100, Math.round(relScore + freshness + rarity + sourceBonus + selfBonus + sizeBonus - recentPenalty)));
  return {
    score,
    breakdown: { relevance: Math.round(relScore), freshness: Math.round(freshness), rarity, sourceBonus, selfBonus, sizeBonus, recentPenalty }
  };
}

/**
 * 排序候选。
 * @returns {{ candidates: object[], items: object[], intents: string[], need: string }}
 */
export function pickStickers(items, context = '', options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5));
  const contextTokens = new Set(tokenize([context, options.topic].filter(Boolean).join(' ')));
  const intentList = detectIntents(context);
  const intentDefs = intentList.map((id) => INTENTS.find((i) => i.id === id)).filter(Boolean);
  const needTokens = new Set(intentDefs.flatMap((i) => tokenize(i.need)));
  const preferSelf = options.preferSelf === true || mentionsSelf(context);
  const recentIds = Array.isArray(options.recentIds) ? options.recentIds : [];
  const now = Number(options.now) || Date.now();
  const ranked = (Array.isArray(items) ? items : [])
    .map((item) => {
      if (!item) return null;
      const { score, breakdown } = scoreStickerItem(item, { contextTokens, needTokens, intents: intentDefs, preferSelf, now, recentIds });
      return { ...item, score, breakdown, label: item.desc || item.localNote || item.title || item.file || item.id };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    candidates: ranked.slice(0, limit),
    items: ranked,
    intents: intentList,
    need: intentList.map((id) => INTENTS.find((i) => i.id === id)?.need || '').filter(Boolean).join(' / ')
  };
}

/**
 * 「此刻是否适合发表情包」硬门（桥接侧约束，AI 只能被它拦住，不会被它强制）。
 *
 * @param {object} state 会话状态（lastAiReplyAt / recentMessages / lastIncomingAt ...）
 * @param {object} opts  { cfg, now, context, incoming }
 * @returns {{ allowed: boolean, reason: string, level: 'good'|'ok'|'no', cooldownLeftMs: number, silentMin: number, lastStickerMinAgo: number|null }}
 */
export function evaluateMoment(state = {}, opts = {}) {
  const cfg = opts.cfg && typeof opts.cfg === 'object' ? opts.cfg : {};
  const now = Number(opts.now) || Date.now();
  const minIntervalMs = Math.max(0, Number(cfg.minIntervalMs) || 0);
  const maxPerTurn = Math.max(1, Number(cfg.maxPerTurn) || 1);
  const recentMessages = Array.isArray(state.recentMessages) ? state.recentMessages : [];

  const stickerMsgs = recentMessages.filter((m) => m && (m.kind === 'sticker' || (m.media || []).some((x) => x && x.kind === 'sticker')));
  const lastSticker = stickerMsgs[stickerMsgs.length - 1];
  const lastStickerAt = Number(state.lastStickerAt) || Number(lastSticker?.time) || 0;
  const lastStickerMinAgo = lastStickerAt ? (now - lastStickerAt) / 60000 : null;

  // 「本轮」= 最近一条别人发的消息之后。要按时间比，不能拿 lastUserTurnAt 这种可能压根
  // 没被写过的字段当基准，否则每一轮都会被判成 0 张。
  const lastIncomingAt = Number(opts.incoming ?? state.lastIncomingAt) || 0;
  const stickersThisTurn = recentMessages.filter((m) => m && m.isSelf
    && (m.kind === 'sticker' || (m.media || []).some((x) => x && x.kind === 'sticker'))
    && (!lastIncomingAt || Number(m.time) >= lastIncomingAt)).length;

  const silentMin = lastIncomingAt ? (now - lastIncomingAt) / 60000 : 0;
  const incomingText = String(opts.context ?? '');
  const serious = looksSerious(incomingText);

  const base = {
    cooldownLeftMs: 0,
    silentMin: Math.round(silentMin * 10) / 10,
    lastStickerMinAgo: lastStickerMinAgo == null ? null : Math.round(lastStickerMinAgo * 10) / 10,
    stickersThisTurn
  };

  if (cfg.enabled === false) return { ...base, allowed: false, level: 'no', reason: '表情包时机判断已关闭' };
  if (serious) return { ...base, allowed: false, level: 'no', reason: '当前语境偏严肃/敏感，不适合发表情包' };
  if (minIntervalMs > 0 && lastStickerAt && now - lastStickerAt < minIntervalMs) {
    return {
      ...base,
      allowed: false,
      level: 'no',
      reason: `距离你上次发表情才 ${Math.round((now - lastStickerAt) / 1000)} 秒（冷却 ${Math.round(minIntervalMs / 1000)} 秒）`,
      cooldownLeftMs: minIntervalMs - (now - lastStickerAt)
    };
  }
  if (stickersThisTurn >= maxPerTurn) {
    return { ...base, allowed: false, level: 'no', reason: `本轮已经发过 ${stickersThisTurn} 张表情了，别再刷` };
  }

  // 语境里有没有「表情包天然适用」的信号
  const intents = detectIntents(incomingText);
  const hasMedia = Array.isArray(state.recentMessages)
    && state.recentMessages.slice(-3).some((m) => m && !m.isSelf && (m.hasMedia || (m.media || []).length));
  let level = 'ok';
  const signals = [];
  if (intents.length) { level = 'good'; signals.push('语境带情绪/梗（' + intents.join('/') + '）'); }
  if (hasMedia) { level = 'good'; signals.push('对方刚发过图/表情，回一张很自然'); }
  if (silentMin >= 30) signals.push('群里静了一会儿，冒泡配图更自然');
  // 时间信息由 moment.lastStickerMinAgo 单独呈现，reason 里不再重复一遍
  if (lastStickerMinAgo == null) signals.push('你还没用过表情包');
  else if (lastStickerMinAgo >= 20) signals.push('距上次发表情已经有一阵了');
  return {
    ...base,
    allowed: true,
    level,
    reason: signals.length ? signals.join('；') : '没有明显信号，但也没到不能发的地步（普通闲聊别硬塞）'
  };
}

// 联网兜底时的风格偏置：让搜出来的图更像表情包，而不是视频截图/动态长图。
export const STYLE_KEYWORDS = ['表情包', '二次元', 'Q版', '沙雕', '梗图'];

// 本地图库里「适合当表情包发」的来源：抓图脚本打 style 标记、人工放的图、AI 自己存的。
// bili-cover / bili-dynamic / bili-article 是资讯配图，不该混进表情候选。
export const STICKER_LIBRARY_SOURCES = ['style', 'manual', 'ai'];

/** 组装联网搜索词（表情包风格偏置）。 */
export function buildOnlineQuery({ topic = '', intents = [], preferSelf = false, styleKeywords = STYLE_KEYWORDS } = {}) {
  const base = [];
  const intentList = Array.isArray(intents) ? intents : [];
  for (const id of intentList.slice(0, 2)) {
    const found = INTENTS.find((i) => i.id === id);
    if (found?.search?.length) base.push(found.search[0].replace(/\s*表情包$/, ''));
  }
  const t = String(topic || '').trim().slice(0, 24);
  const head = t || base.join(' ') || '日常';
  const style = preferSelf
    ? ['deepseek娘', '小鲸鱼 表情包']
    : (Array.isArray(styleKeywords) && styleKeywords.length ? styleKeywords.slice(0, 2) : ['表情包']);
  return [...new Set([head, ...style])].join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 汇总一次「选表情」的决策（AI 调用 qq_pick_sticker 时桥接内部用）。
 * 只做建议，不做发送。
 */
export function buildPickPlan({ qqItems = [], libraryItems = [], context = '', topic = '', moment = null, options = {} } = {}) {
  const cfg = options.cfg && typeof options.cfg === 'object' ? options.cfg : {};
  const minScore = Math.max(0, Math.min(100, Number(options.minScore ?? cfg.minScore) || 0));
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 5));
  const recentIds = Array.isArray(options.recentIds) ? options.recentIds : [];
  const includeLibrary = cfg.includeLibrary !== false;
  const pool = [
    ...(Array.isArray(qqItems) ? qqItems : []).map((x) => normalizePickItem(x, 'qq')).filter(Boolean),
    ...(includeLibrary ? (Array.isArray(libraryItems) ? libraryItems : []).map((x) => normalizePickItem(x, 'library')).filter(Boolean) : [])
  ];
  const picked = pickStickers(pool, [context, topic].filter(Boolean).join(' '), { limit, recentIds, preferSelf: options.preferSelf });
  const best = picked.candidates[0] || null;
  const decided = Boolean(best) && best.score >= minScore;
  const serousContext = looksSerious([context, topic].filter(Boolean).join(' '));
  const searchTopics = Array.from(new Set(picked.intents));
  return {
    moment,
    intents: picked.intents,
    need: picked.need,
    topic: String(topic || '').slice(0, 40),
    minScore,
    decided,
    best: decided ? best : null,
    candidates: picked.candidates,
    poolSize: pool.length,
    onlineQuery: buildOnlineQuery({
      topic,
      intents: searchTopics,
      preferSelf: options.preferSelf === true || mentionsSelf([context, topic].filter(Boolean).join(' ')),
      styleKeywords: cfg.styleKeywords
    }),
    serious: serousContext
  };
}
