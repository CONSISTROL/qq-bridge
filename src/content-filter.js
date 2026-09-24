// 入站内容策略：有些请求根本不该让 AI 去「想」。
//
// 背景（真实事故）：有人在私聊里反复发同一类越线请求，模型的文本输出在 reserved2 下
// 不自动转发，于是它每轮都花掉一次完整的思考 + 一次拒绝生成 + 一次收尾观察，
// 对方却什么都收不到——既费 token 又给人「它不理我」的观感。
//
// 这里的做法是**在消息进队列之前拦掉**：命中就由桥接自己回一句固定的短话（或干脆不回），
// 消息不进未读、不触发唤醒、不写进会话上下文，模型那一侧连"发生过这件事"都不知道。
//
// 设计约束：
// - 纯函数 + 显式配置，便于单测（scripts/test-content-filter.mjs）；
// - 词表全部可在 config.json 的 `moderation` 段里改，代码里只放一份保守默认值；
// - 判定是启发式的，宁可漏杀也不误杀正常聊天：默认词表只收「明确越线」的词，
//   字符名一类歧义词（如「可莉」「纳西妲」）**默认不拦**，要拦由管理员自己写进 extraPatterns；
// - matching: 'substring'（默认，包含即命中）或 'regex'（整串按正则匹配，写错不会命中，不会误杀）。

export const DEFAULT_MODERATION = Object.freeze({
  enabled: true,
  action: 'reply',                 // reply = 回一句固定文本；silent = 完全不理（连回都不回）
  replyText: '这个我不接，换一个吧',   // action=reply 时发出去的原文（桥接自己发，不经过模型）
  matching: 'substring',           // substring | regex
  logMatch: false,                 // true 时把命中的原话写进活动日志（默认只在日志里记「命中」）
  cooldownMs: 0,                   // 同一会话同一模式的固定回复冷却（0=每次都回）
  extraPatterns: [],               // 追加词/正则
  patterns: []
});

const PROTECTED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function clampText(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function asStringList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,，\n]/);
  return list.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * 归一化配置：非法值一律退回「保守但有界」的默认，绝不让写错的配置把拦截关掉或放大。
 * 返回 { enabled, action, replyText, matching, logMatch, cooldownMs, patterns: [...] }。
 */
export function normalizeModeration(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const enabled = cfg.enabled !== false; // 默认开
  const action = cfg.action === 'silent' ? 'silent' : 'reply';
  const matching = cfg.matching === 'regex' ? 'regex' : 'substring';
  const replyText = clampText(cfg.replyText ?? DEFAULT_MODERATION.replyText, 120) || DEFAULT_MODERATION.replyText;
  const cooldownMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Number(cfg.cooldownMs) || 0));
  const extra = asStringList(cfg.extraPatterns);
  // patterns 显式传空数组 = 不拦（管理员清空词表），传 undefined = 用默认词表。
  const patterns = cfg.patterns === undefined
    ? [...DEFAULT_MODERATION.patterns]
    : asStringList(cfg.patterns);
  const seen = new Set();
  const clean = [];
  for (const p of [...patterns, ...extra]) {
    if (!p || PROTECTED_NAMES.has(p)) continue;
    const key = `${matching}:${p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(p.slice(0, 100));
    if (clean.length >= 500) break;
  }
  return { enabled, action, replyText, matching, logMatch: cfg.logMatch === true, cooldownMs, patterns: clean };
}

/**
 * 判定一条文本要不要拦。
 * @returns {{blocked:boolean, matched?:string}}
 */
export function checkContent(text, config) {
  const cfg = config && typeof config === 'object' && 'patterns' in config ? config : normalizeModeration(config);
  const s = String(text ?? '');
  if (!cfg.enabled || !s || !cfg.patterns.length) return { blocked: false };
  if (cfg.matching === 'regex') {
    for (const p of cfg.patterns) {
      let re;
      try { re = new RegExp(p, 'i'); } catch { continue; } // 写错的正则跳过，绝不因此拦人
      if (re.test(s)) return { blocked: true, matched: p };
    }
    return { blocked: false };
  }
  const lower = s.toLowerCase();
  for (const p of cfg.patterns) {
    if (lower.includes(p.toLowerCase())) return { blocked: true, matched: p };
  }
  return { blocked: false };
}

/**
 * 带「同会话冷却」的判定器。返回 { blocked, matched, reply }：
 * reply = 需要由桥接发出去的固定回复文本；silent 模式或冷却期内为空串。
 * 结算只应在真的要拦下这条消息时调用 settle()——没拦下的消息不该占用冷却。
 */
export function createContentGate(config, { now = () => Date.now() } = {}) {
  const cfg = normalizeModeration(config);
  const lastHit = new Map(); // `${key}\0${matched}` -> ts
  return {
    config: cfg,
    check(text, { key = '' } = {}) {
      const verdict = checkContent(text, cfg);
      if (!verdict.blocked) return { blocked: false };
      const t = now();
      const slot = `${String(key)}\u0000${verdict.matched}`;
      const last = lastHit.get(slot) || 0;
      if (cfg.cooldownMs > 0 && t - last < cfg.cooldownMs) {
        return { blocked: true, matched: verdict.matched, reply: '', throttled: true };
      }
      lastHit.set(slot, t);
      if (lastHit.size > 2000) {
        // 有界：超出就丢最旧的一半，避免长期运行把 Map 撑大
        const entries = [...lastHit.entries()].sort((a, b) => a[1] - b[1]);
        for (const [k] of entries.slice(0, entries.length - 1000)) lastHit.delete(k);
      }
      return { blocked: true, matched: verdict.matched, reply: cfg.action === 'silent' ? '' : cfg.replyText };
    }
  };
}
