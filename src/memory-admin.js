// AI 记忆管理：把散落在各个状态文件里的「AI 记住的东西」收进一个统一的
// 清单 / 增删改查 / 自然遗忘 / 备份回滚 接口，供控制台的「AI 记忆」分区使用。
//
// 为什么需要它：AI 的记忆不是一个文件，而是七类东西——
//   1. 轻量记忆   state/social-v2.json   进行中的话题 / 想说没说的话 / 对群友的印象（会注入提示词）
//   2. 成员备注   state/member-remarks.json  按 会话+QQ 号 索引的「谁是谁」（AI 主动查，不注入）
//   3. 黑话库     state/slang.json       词 → 含义（确认后进提示词/检索）
//   4. 群知识库   state/knowledge.json   问题 → 答案（按需检索注入）
//   5. 表情笔记   state/stickers.json    收藏表情的含义/用法（选表情时参考）
//   6. 对话上下文 state/social-v2.json 的 recentMessages/unread + ~/.dsh 会话转录（真正的聊天原文）
//   7. 长期记忆   ~/.dsh/AGENTS.md 等文件（AI 自己读写，桥接不代管，只在此登记位置）
// 以前它们各管各的：清记忆只有 forget-user.sh 一条路（要停桥接、清整个会话），
// 网页控制台只能看到第 1、2 类的一部分。这个模块把它们统一起来，并补上三件缺的事：
//   · **钉住（pin）**：重要的记忆写进 state/memory-pins.json，之后所有「清空/遗忘」都跳过它；
//   · **备份/回滚**：任何时候都能先备份再动手，删错了能整份还原（另见 state/backups）；
//   · **自然遗忘**：按内容规则（过期想法、搁置话题、长期没用的表情）批量清理，而不是一刀切。
//
// 边界：remove/clear（逐条删、批量清空）只给控制台用，**AI 够不到**（带 x-agent-token 一律 403）。
// 钉住保护的是「批量动作」：清空/自然遗忘会跳过钉住的条目（除非显式 includePinned），
// 而逐条 remove 是「点名删这一条」，不受钉住保护——按错了还有备份可以回滚。
//
// 设计约束：
// - 全部读写都走桥接**运行中的内存态**（通过 getter/injected setter），改完立刻生效、不用重启；
// - 所有破坏性操作（清空/回滚）先自动备份，答案里带回备份名，控制台可直接一键回滚；
// - 纯函数 + 注入依赖，便于 scripts/test-memory-admin.mjs 在临时目录里端到端跑。

import fs from 'node:fs';
import path from 'node:path';

export const MEMORY_KIND = Object.freeze({
  TOPIC: 'lightTopic',
  THOUGHT: 'lightThought',
  IMPRESSION: 'impression',
  REMARK: 'remark',
  SLANG: 'slang',
  KNOWLEDGE: 'knowledge',
  STICKER: 'stickerNote',
  CONTEXT: 'context'
});

export const MEMORY_KINDS = Object.freeze(Object.values(MEMORY_KIND));

// 「自然遗忘」的三条默认规则（都可被请求覆盖）：
// 想法默认 2h 过期（appendMemoryV2 的默认值）、话题 24h 没被提起算搁置、
// 收藏表情 90 天没发过就当只是囤着。阈值都偏保守：宁可少清，不要错杀。
export const FORGET_DEFAULTS = Object.freeze({
  thoughtTtlMs: 2 * 60 * 60 * 1000,
  topicIdleMs: 24 * 60 * 60 * 1000,
  stickerIdleMs: 90 * 24 * 60 * 60 * 1000
});

const PIN_FILE_VERSION = 1;
const PIN_MAX = 5000;
const PIN_REASON_MAX = 60;
const BACKUP_KEEP_MAX = 30;
const BACKUP_NAME_RE = /^memory-[0-9]{8}-[0-9]{6}(-[0-9]+)?$/;
const SNAPSHOT_FILES = ['social-v2.json', 'member-remarks.json', 'slang.json', 'knowledge.json', 'stickers.json'];
const SNAPSHOT_LABEL = {
  'social-v2.json': '轻量记忆 + 对话上下文',
  'member-remarks.json': '群成员备注',
  'slang.json': '黑话库',
  'knowledge.json': '群知识库',
  'stickers.json': '收藏表情 + 表情笔记'
};

const PROTECTED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function clampText(value, max) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function safeName(value) {
  const s = String(value ?? '').trim();
  return s && !PROTECTED_NAMES.has(s) ? s : '';
}

/**
 * 粗略 token 估算：中文一字 ≈ 1 token，英文按 4 字符 ≈ 1 token。
 * 只用来给管理员看「哪类记忆在吃上下文」，不追求和真 tokenizer 对齐。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function nowIso() {
  return new Date().toISOString();
}

/** 数字描述：内容条数 + 字符数 + 估算 token。 */
function measure(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter((x) => x != null);
  const chars = list.reduce((sum, x) => sum + String(x).length, 0);
  return { items: list.length, chars, tokens: estimateTokens(list.join('\n')) };
}

function readJsonSafe(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function atomicWrite(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dirSize(dir) {
  let bytes = 0;
  let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        count += 1;
        try { bytes += fs.statSync(full).size; } catch { /* 文件刚被删 */ }
      }
    }
  };
  walk(dir);
  return { bytes, count };
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

/** 钉住表：文件里的数组 ⇄ 查询用的 Set。 */
export function pinKey(kind, id, id2 = '') {
  return `${String(kind ?? '')}\u0000${String(id ?? '')}\u0000${String(id2 ?? '')}`;
}

/**
 * 钉住记录统一长这样：{ kind, scope, item, at, source, reason }
 * - scope = 会话 key（全局类记忆为空串）；
 * - item  = 条目标识：话题/想法用**数组下标**（`topic:2` / `thought:0`），
 *           印象用群友名字，备注用 QQ 号，黑话/知识/表情用条目 id。
 *
 * 为什么话题/想法不用原文：文本是会被改写的（追加时会 trim、还有别的写路径会重写），
 * 用原文当钥匙会出现「明明钉住了、清空时却没被保护」——钉住是安全承诺，不能靠字符串相等。
 * 下标在「追加 + 过滤删除」的用法下足够稳；插入式改动会让钉子错位，但不会误删别的东西。
 */
export function pinToKey(pin) {
  return pinKey(pin?.kind, pin?.scope, pin?.item);
}

/** 话题/想法的钉住标识：优先用持久化过的 id，没有就退回数组下标。 */
export function topicPinId(topic, index) {
  const explicit = String(topic?.pinId ?? topic?.id ?? '').trim();
  return explicit || `topic:${Number(index) || 0}`;
}

export function thoughtPinId(thought, index) {
  const explicit = String(thought?.pinId ?? thought?.id ?? '').trim();
  return explicit || `thought:${Number(index) || 0}`;
}

export function normalizePin(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const kind = String(p.kind ?? '').trim();
  const scope = String(p.scope ?? p.id ?? '').trim();
  const item = String(p.item ?? p.id2 ?? '').trim();
  if (!kind || !item) return null;
  const at = String(p.at || '').trim() || nowIso();
  return { kind, scope, item, at, source: p.source === 'console' ? 'console' : 'manual', reason: clampText(p.reason, PIN_REASON_MAX) };
}

export function loadPins(file) {
  const raw = readJsonSafe(file, null);
  const list = Array.isArray(raw?.pins) ? raw.pins : (Array.isArray(raw) ? raw : []);
  const pins = [];
  const seen = new Set();
  for (const item of list) {
    const pin = normalizePin(item);
    if (!pin) continue;
    const key = pinToKey(pin);
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push(pin);
    if (pins.length >= PIN_MAX) break;
  }
  return { version: PIN_FILE_VERSION, pins };
}

/**
 * AI 记忆管理模块。
 *
 * @param {object} deps
 * @param {string} deps.stateDir            state 目录（备份、钉住表都放这里）
 * @param {string} deps.socialFile          social-v2.json 路径（备份用）
 * @param {string} deps.memberRemarksFile   member-remarks.json 路径
 * @param {string} deps.slangFile           slang.json 路径
 * @param {string} deps.knowledgeFile       knowledge.json 路径
 * @param {string} deps.stickerFile         stickers.json 路径
 * @param {string} [deps.agentsFile]        ~/.dsh/AGENTS.md（只登记位置，不代管）
 * @param {object} deps.social              { conversations: Map, paused }
 * @param {object} deps.memberStore         { conversations: { key: { qq: entry } } }
 * @param {Function} deps.saveSocial        () => void  落盘 social-v2.json
 * @param {Function} deps.saveMembers       () => void  落盘 member-remarks.json
 * @param {Function} deps.getSlang          () => slangEntry[]
 * @param {Function} deps.setSlang          (entries) => void  落盘黑话库
 * @param {Function} deps.getKnowledge      () => knowledgeEntry[]
 * @param {Function} deps.setKnowledge      (entries) => void  落盘知识库
 * @param {Function} deps.getStickers       () => stickerEntry[]
 * @param {Function} deps.setStickers       (entries) => void  落盘表情库
 * @param {Function} [deps.log]             日志回调
 */
export function createMemoryAdmin(deps) {
  const {
    stateDir,
    socialFile,
    memberRemarksFile,
    slangFile,
    knowledgeFile,
    stickerFile,
    agentsFile = '',
    social,
    memberStore,
    saveSocial,
    saveMembers,
    getSlang,
    setSlang,
    getKnowledge,
    setKnowledge,
    getStickers,
    setStickers,
    sessionMap = () => ({}),
    log = () => {}
  } = deps;

  const pinFile = path.join(stateDir, 'memory-pins.json');
  const backupRoot = path.join(stateDir, 'backups');
  let pinStore = loadPins(pinFile);

  function savePins() {
    atomicWrite(pinFile, pinStore);
  }

  /** 会话 key 的稳定排序：群在前、私聊在后，同类型按数字升序。 */
  function sortKeys(keys) {
    return [...keys].sort((a, b) => {
      const ga = a.startsWith('group:') ? 0 : 1;
      const gb = b.startsWith('group:') ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const na = Number(String(a).split(':')[1]) || 0;
      const nb = Number(String(b).split(':')[1]) || 0;
      return na - nb;
    });
  }

  function conversationKeys() {
    const keys = new Set(social?.conversations?.keys?.() ?? []);
    for (const k of Object.keys(memberStore?.conversations ?? {})) keys.add(k);
    return sortKeys([...keys].filter((k) => /^(group|private):\d+$/.test(k)));
  }

  function messagesOf(st) {
    const s = st || {};
    return [...(Array.isArray(s.recentMessages) ? s.recentMessages : []), ...(Array.isArray(s.unread) ? s.unread : [])];
  }

  // ── 清单：七类记忆各自多少条、多少 token、钉了几条 ────────────────────
  function inventory() {
    const pins = new Set(pinStore.pins.map(pinToKey));
    const pinnedOf = (kind, id, id2 = '') => pins.has(pinKey(kind, id, id2));
    const keys = conversationKeys();
    const conversations = [];
    let topicLines = [];
    let thoughtLines = [];
    let impressionLines = [];
    let remarkLines = [];
    let contextLines = [];
    let topicItems = 0;
    let thoughtItems = 0;
    let impressionItems = 0;
    let remarkItems = 0;
    let pinnedTotal = 0;

    for (const key of keys) {
      const st = social?.conversations?.get?.(key) ?? {};
      const topics = (Array.isArray(st.activeTopics) ? st.activeTopics : []).filter((t) => t && String(t.text || '').trim());
      const thoughts = (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : []).filter((t) => t && String(t.text || '').trim());
      const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
      const remarks = memberStore?.conversations?.[key] && typeof memberStore.conversations[key] === 'object' ? memberStore.conversations[key] : {};
      const impNames = Object.keys(impressions).filter(safeName);
      const remarkList = Object.values(remarks).filter((e) => e && safeName(e.qq));

      topics.forEach((t, i) => {
        topicItems += 1;
        if (pinnedOf(MEMORY_KIND.TOPIC, key, topicPinId(t, i))) pinnedTotal += 1;
        topicLines.push(`- ${t.text}${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      });
      thoughts.forEach((t, i) => {
        thoughtItems += 1;
        if (pinnedOf(MEMORY_KIND.THOUGHT, key, thoughtPinId(t, i))) pinnedTotal += 1;
        thoughtLines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      });
      for (const name of impNames) {
        impressionItems += 1;
        if (pinnedOf(MEMORY_KIND.IMPRESSION, key, name)) pinnedTotal += 1;
        const im = impressions[name] || {};
        impressionLines.push(`- ${name}：${Array.isArray(im.traits) ? im.traits.join('、') : ''}`);
      }
      for (const r of remarkList) {
        remarkItems += 1;
        if (pinnedOf(MEMORY_KIND.REMARK, key, String(r.qq))) pinnedTotal += 1;
        remarkLines.push(`- ${r.remark || '（未命名）'}（QQ ${r.qq}）${r.note ? `｜${r.note}` : ''}`);
      }

      const msgs = messagesOf(st);
      const last = msgs.reduce((max, m) => Math.max(max, Number(m?.time) || 0), 0);
      contextLines.push(...msgs.map((m) => String(m?.tail || m?.plain || m?.text || '')));
      conversations.push({
        key,
        topics: topics.length,
        thoughts: thoughts.length,
        impressions: impNames.length,
        remarks: remarkList.length,
        recent: Array.isArray(st.recentMessages) ? st.recentMessages.length : 0,
        unread: Array.isArray(st.unread) ? st.unread.length : 0,
        seenForwards: Array.isArray(st.seenForwardIds) ? st.seenForwardIds.length : (st.seenForwardIds?.size ?? 0),
        lastAt: last || Number(st.lastIncomingAt) || 0
      });
    }

    const slang = (getSlang() || []).filter((e) => e && e.content);
    const knowledge = (getKnowledge() || []).filter((e) => e && e.question);
    const stickers = (getStickers() || []).filter((e) => e && e.id);
    const stickerNotes = stickers.filter((e) => String(e.localNote || '').trim() || String(e.desc || '').trim());

    const kindLine = (e) => `${e.content}｜${e.meaning || ''}｜${e.usage || ''}｜${e.example || ''}`;
    const knowledgeLine = (e) => `${e.question}｜${e.answer}`;
    const stickerLine = (e) => `${e.localNote || ''}｜${e.desc || ''}｜${(e.tags || []).join('、')}`;

    const confirmedSlang = slang.filter((e) => e.status === 'confirmed');
    const candidateSlang = slang.filter((e) => e.status === 'candidate');
    const confirmedKnowledge = knowledge.filter((e) => e.status === 'confirmed');
    const candidateKnowledge = knowledge.filter((e) => e.status !== 'confirmed');

    let agents = { exists: false, path: agentsFile, bytes: 0, lines: 0, managed: false };
    if (agentsFile) {
      try {
        const text = fs.readFileSync(agentsFile, 'utf8');
        agents = { exists: true, path: agentsFile, bytes: Buffer.byteLength(text), lines: text.split('\n').length, managed: false };
      } catch { /* 没有这个文件也很正常 */ }
    }

    const groups = [
      {
        id: 'session',
        title: '会话记忆（会注入提示词）',
        scope: 'per-session',
        inject: 'inject',
        note: '每次唤醒都会拼进系统提示词：进行中的话题、想说没说的话、对群友的印象。',
        stats: {
          topics: { ...measure(topicLines), ...{ raw: topicItems } },
          thoughts: { ...measure(thoughtLines), raw: thoughtItems },
          impressions: { ...measure(impressionLines), raw: impressionItems }
        },
        total: { items: topicItems + thoughtItems + impressionItems, tokens: measure(topicLines).tokens + measure(thoughtLines).tokens + measure(impressionLines).tokens }
      },
      {
        id: 'members',
        title: '群成员备注（AI 主动查）',
        scope: 'per-session',
        inject: 'onDemand',
        note: '按「会话 + QQ 号」索引的谁是谁。默认不注入提示词，AI 想认人时自己调 qq_get_member_remarks。',
        stats: { remarks: { ...measure(remarkLines), raw: remarkItems } },
        total: { items: remarkItems, tokens: measure(remarkLines).tokens }
      },
      {
        id: 'context',
        title: '对话上下文与原始转录',
        scope: 'mixed',
        inject: 'inject',
        note: '桥接侧保留的最近消息/未读（唤醒时按需给 AI 看）；真正的聊天原文在 DSH 会话转录里，由 DSH 管理，桥接只负责「清除上下文」。',
        stats: {
          messages: measure(contextLines),
          sessions: Object.keys(sessionMap() ?? {}).length
        },
        total: { items: contextLines.length, tokens: measure(contextLines).tokens }
      },
      {
        id: 'slang',
        title: '黑话库（词 → 含义）',
        scope: 'global',
        inject: 'search',
        note: '确认过的黑话进提示词与语义检索；候选还要人工确认才生效。',
        stats: {
          confirmed: measure(confirmedSlang.map(kindLine)),
          candidate: measure(candidateSlang.map(kindLine)),
          rejected: { items: slang.length - confirmedSlang.length - candidateSlang.length, chars: 0, tokens: 0 }
        },
        total: { items: slang.length, tokens: measure(confirmedSlang.map(kindLine)).tokens }
      },
      {
        id: 'knowledge',
        title: '群知识库（问题 → 答案）',
        scope: 'global',
        inject: 'search',
        note: '有人问到相似问题时按语义检索注入答案；待确认候选是还没生效的。',
        stats: {
          confirmed: measure(confirmedKnowledge.map(knowledgeLine)),
          candidate: measure(candidateKnowledge.map(knowledgeLine))
        },
        total: { items: knowledge.length, tokens: measure(confirmedKnowledge.map(knowledgeLine)).tokens }
      },
      {
        id: 'stickers',
        title: '收藏表情与其含义笔记',
        scope: 'global',
        inject: 'onDemand',
        note: '表情本身在 QQ 账号上；这里管的是 AI 给表情写的备注/标签（选表情时参考）。',
        stats: {
          stickers: { items: stickers.length, chars: 0, tokens: 0 },
          notes: measure(stickerNotes.map(stickerLine))
        },
        total: { items: stickers.length, tokens: measure(stickerNotes.map(stickerLine)).tokens }
      },
      {
        id: 'longterm',
        title: '长期记忆文件（DSH 侧）',
        scope: 'global',
        inject: 'inject',
        note: 'AGENTS.md 这类文件由 AI 自己读写（DSH 每轮都会读），桥接不代管——只在这里登记位置，改它请去 DSH 工作区。',
        stats: { file: { items: agents.exists ? 1 : 0, chars: agents.bytes, tokens: estimateTokens(agents.bytes) } },
        total: { items: agents.exists ? 1 : 0, tokens: estimateTokens(agents.bytes) }
      }
    ];

    return {
      ok: true,
      generatedAt: nowIso(),
      conversations,
      groups,
      tokens: {
        note: '估算值：中文 1 字≈1 token、英文 4 字符≈1 token，只用于比较各类记忆的相对开销',
        injectedPerWake: groups[0].total.tokens,
        searchable: groups[3].total.tokens + groups[4].total.tokens,
        onDemand: groups[1].total.tokens + groups[2].total.tokens + groups[5].total.tokens
      },
      pins: { total: pinStore.pins.length, items: pinStore.pins },
      agents,
      files: [
        { file: socialFile, label: '轻量记忆 + 对话上下文', exists: fs.existsSync(socialFile) },
        { file: memberRemarksFile, label: '群成员备注', exists: fs.existsSync(memberRemarksFile) },
        { file: slangFile, label: '黑话库', exists: fs.existsSync(slangFile) },
        { file: knowledgeFile, label: '群知识库', exists: fs.existsSync(knowledgeFile) },
        { file: stickerFile, label: '收藏表情笔记', exists: fs.existsSync(stickerFile) },
        { file: pinFile, label: '钉住表（清空时保护）', exists: fs.existsSync(pinFile) }
      ],
      backups: listBackups().slice(0, 5)
    };
  }

  // ── 逐类列出条目（控制台列表 + 搜索）──────────────────────────────────
  function items({ kind, key = '', q = '', limit = 300 } = {}) {
    const needle = String(q ?? '').trim().toLowerCase();
    const wantKey = String(key ?? '').trim();
    const max = Math.max(1, Math.min(2000, Number(limit) || 300));
    const pinned = new Set(pinStore.pins.map(pinToKey));
    const out = [];

    const push = (item) => out.push({ ...item, pinned: pinned.has(pinKey(item.kind, item.key || '', item.pinId || item.id)) });
    const match = (...fields) => !needle || fields.some((f) => String(f ?? '').toLowerCase().includes(needle));

    if (kind === MEMORY_KIND.TOPIC || kind === MEMORY_KIND.THOUGHT) {
      const field = kind === MEMORY_KIND.TOPIC ? 'activeTopics' : 'pendingThoughts';
      for (const k of conversationKeys()) {
        if (wantKey && wantKey !== k) continue;
        const st = social?.conversations?.get?.(k) ?? {};
        (Array.isArray(st[field]) ? st[field] : []).forEach((t, index) => {
          const text = String(t?.text || '');
          if (!text) return;
          if (kind === MEMORY_KIND.THOUGHT && t?.expiresAt && Date.now() >= Number(t.expiresAt)) return;
          if (!match(text, t?.pendingQuestion, t?.motivation)) return;
          push({
            kind,
            key: k,
            id: text,
            // pinId 是钉住/清空时用的稳定标识（话题/想法用下标，见 pinToKey 注释）
            pinId: kind === MEMORY_KIND.TOPIC ? topicPinId(t, index) : thoughtPinId(t, index),
            text,
            pendingQuestion: t?.pendingQuestion ? String(t.pendingQuestion) : '',
            motivation: t?.motivation ? String(t.motivation) : '',
            participants: Array.isArray(t?.participants) ? t.participants : [],
            at: Number(t?.lastMentionAt || t?.createdAt) || 0,
            expiresAt: Number(t?.expiresAt) || 0
          });
        });
      }
    } else if (kind === MEMORY_KIND.IMPRESSION) {
      for (const k of conversationKeys()) {
        if (wantKey && wantKey !== k) continue;
        const impressions = social?.conversations?.get?.(k)?.memberImpressions ?? {};
        for (const name of Object.keys(impressions)) {
          if (!safeName(name)) continue;
          const im = impressions[name] || {};
          const traits = Array.isArray(im.traits) ? im.traits.map(String) : [];
          if (!match(name, traits.join('、'))) continue;
          push({
            kind,
            key: k,
            id: name,
            text: `${name}：${traits.join('、')}`,
            traits,
            interactionCount: Number(im.interactionCount) || 0,
            at: Number(im.lastAt || im.updatedAt) || 0
          });
        }
      }
    } else if (kind === MEMORY_KIND.REMARK) {
      for (const k of conversationKeys()) {
        if (wantKey && wantKey !== k) continue;
        const list = memberStore?.conversations?.[k];
        if (!list || typeof list !== 'object') continue;
        for (const entry of Object.values(list)) {
          if (!entry || !safeName(entry.qq)) continue;
          if (!match(entry.qq, entry.remark, entry.note, entry.nick)) continue;
          push({
            kind,
            key: k,
            id: String(entry.qq),
            text: `${entry.remark || '（未命名）'}（QQ ${entry.qq}）`,
            remark: String(entry.remark || ''),
            note: String(entry.note || ''),
            nick: String(entry.nick || ''),
            source: entry.source === 'manual' ? 'manual' : 'ai',
            at: Date.parse(entry.updatedAt || entry.createdAt || '') || 0
          });
        }
      }
    } else if (kind === MEMORY_KIND.SLANG) {
      for (const e of (getSlang() || [])) {
        if (!e || !e.content) continue;
        if (!match(e.content, e.meaning, e.usage, e.example, (e.tags || []).join('、'))) continue;
        push({
          kind,
          key: '',
          id: String(e.id),
          text: String(e.content),
          meaning: String(e.meaning || ''),
          usage: String(e.usage || ''),
          example: String(e.example || ''),
          status: String(e.status || ''),
          tags: Array.isArray(e.tags) ? e.tags : [],
          count: Number(e.count) || 0,
          at: Date.parse(e.updatedAt || e.createdAt || '') || 0
        });
      }
    } else if (kind === MEMORY_KIND.KNOWLEDGE) {
      for (const e of (getKnowledge() || [])) {
        if (!e || !e.question) continue;
        if (!match(e.question, e.answer, (e.aliases || []).join('、'), (e.tags || []).join('、'))) continue;
        push({
          kind,
          key: '',
          id: String(e.id),
          text: String(e.question),
          answer: String(e.answer || ''),
          status: String(e.status || ''),
          kindLabel: String(e.kind || ''),
          hitCount: Number(e.hitCount) || 0,
          revision: Number(e.revision) || 0,
          conflict: e.conflict ? 1 : 0,
          at: Date.parse(e.updatedAt || e.createdAt || '') || 0
        });
      }
    } else if (kind === MEMORY_KIND.STICKER) {
      for (const e of (getStickers() || [])) {
        if (!e || !e.id) continue;
        if (!match(e.localNote, e.desc, (e.tags || []).join('、'), e.usage)) continue;
        push({
          kind,
          key: '',
          id: String(e.id),
          text: String(e.localNote || e.desc || '（还没有备注的表情）'),
          note: String(e.localNote || ''),
          desc: String(e.desc || ''),
          tags: Array.isArray(e.tags) ? e.tags : [],
          usage: String(e.usage || ''),
          useCount: Number(e.useCount) || 0,
          at: Date.parse(e.updatedAt || e.createdAt || '') || 0
        });
      }
    } else if (kind === MEMORY_KIND.CONTEXT) {
      for (const k of conversationKeys()) {
        if (wantKey && wantKey !== k) continue;
        const st = social?.conversations?.get?.(k) ?? {};
        const mark = (list, bucket) => {
          for (const m of (Array.isArray(list) ? list : [])) {
            const text = String(m?.tail || m?.plain || m?.text || '').trim();
            if (!match(text, m?.userId, m?.sender)) continue;
            push({
              kind,
              key: k,
              id: String(m?.id ?? m?.seq ?? ''),
              id2: bucket,
              text,
              sender: String(m?.sender || m?.userId || ''),
              isSelf: !!m?.isSelf,
              unread: bucket === 'unread',
              at: Number(m?.time) || 0
            });
          }
        };
        mark(st.recentMessages, 'recent');
        mark(st.unread, 'unread');
      }
    } else {
      return { ok: false, error: `未知的记忆类型：${kind || '(空)'}` };
    }

    out.sort((a, b) => (b.at || 0) - (a.at || 0));
    return {
      ok: true,
      kind,
      total: out.length,
      items: out.slice(0, max),
      kinds: MEMORY_KINDS,
      conversations: conversationKeys()
    };
  }

  // ── 钉住 / 取消钉住 ──────────────────────────────────────────────────
  // key = 会话 key（全局类记忆留空），id = 条目标识（话题/想法原文、群友名字、QQ 号、条目 id）。
  function setPin({ kind, key = '', id = '', pinned, reason = '' } = {}) {
    const kindName = String(kind ?? '').trim();
    const pinId = String(id ?? '').trim();
    const convKey = String(key ?? '').trim();
    if (!MEMORY_KINDS.includes(kindName)) return { ok: false, error: `未知的记忆类型：${kindName || '(空)'}` };
    if (!pinId) return { ok: false, error: 'id 不能为空' };
    if (kindName !== MEMORY_KIND.SLANG && kindName !== MEMORY_KIND.KNOWLEDGE && kindName !== MEMORY_KIND.STICKER && !convKey) {
      return { ok: false, error: '这个记忆类型需要 key（会话）' };
    }
    const k = pinKey(kindName, convKey, pinId);
    const before = pinStore.pins.length;
    pinStore.pins = pinStore.pins.filter((p) => pinToKey(p) !== k);
    const removed = pinStore.pins.length < before;
    if (pinned !== false) {
      pinStore.pins.push({
        kind: kindName,
        scope: convKey,
        item: pinId,
        at: nowIso(),
        source: 'console',
        reason: clampText(reason, PIN_REASON_MAX)
      });
      if (pinStore.pins.length > PIN_MAX) pinStore.pins.splice(0, pinStore.pins.length - PIN_MAX);
      savePins();
      return { ok: true, pinned: true, pins: pinStore.pins.length };
    }
    if (removed) savePins();
    return { ok: true, pinned: false, removed, pins: pinStore.pins.length };
  }

  // ── 备份 / 回滚 ──────────────────────────────────────────────────────
  /** 备份名：memory-YYYYMMDD-HHMMSS，同一秒内再打就加 -N 后缀（BACKUP_NAME_RE 认这个格式）。 */
  function backupName(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let name = `memory-${stamp}`;
    let n = 1;
    while (fs.existsSync(path.join(backupRoot, name))) name = `memory-${stamp}-${n++}`;
    return name;
  }

  function createBackup(reason = 'manual') {
    const name = backupName();
    const dir = path.join(backupRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const copied = [];
    for (const file of SNAPSHOT_FILES) {
      const src = path.join(stateDir, file);
      if (!fs.existsSync(src)) continue;
      try {
        fs.copyFileSync(src, path.join(dir, file));
        copied.push(file);
      } catch (error) {
        log(`[memory] 备份 ${file} 失败：${error?.message ?? error}`);
      }
    }
    try {
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        name,
        createdAt: nowIso(),
        reason: clampText(reason, 80) || 'manual',
        files: copied.map((file) => ({ file, label: SNAPSHOT_LABEL[file] || file }))
      }, null, 2), 'utf8');
    } catch { /* meta 失败不影响主流程 */ }
    pruneBackups();
    return { name, dir, files: copied, createdAt: nowIso() };
  }

  /** 只删本模块自己建的 memory-* 备份目录，最多留 BACKUP_KEEP_MAX 份。 */
  function pruneBackups() {
    try {
      const dirs = fs.readdirSync(backupRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && BACKUP_NAME_RE.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const name of dirs.slice(BACKUP_KEEP_MAX)) rmrf(path.join(backupRoot, name));
    } catch { /* 目录还不存在 */ }
  }

  function listBackups() {
    let entries = [];
    try {
      entries = fs.readdirSync(backupRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    return entries
      .filter((name) => safeName(name) && !name.includes('/') && !name.includes('..'))
      .map((name) => {
        const dir = path.join(backupRoot, name);
        const meta = readJsonSafe(path.join(dir, 'meta.json'), null);
        const { bytes, count } = dirSize(dir);
        const managed = BACKUP_NAME_RE.test(name);
        const files = [];
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f === 'meta.json') continue;
            files.push({ file: f, label: SNAPSHOT_LABEL[f] || (managed ? f : '外部备份文件'), bytes: fs.statSync(path.join(dir, f)).size });
          }
        } catch { /* 读不到就只报名字 */ }
        return {
          name,
          createdAt: meta?.createdAt || '',
          reason: meta?.reason || (managed ? '（无 meta）' : '外部备份（如 forget-user.sh）'),
          managed,
          restorable: managed || files.some((f) => f.file.endsWith('.json')),
          bytes,
          count,
          files
        };
      })
      .sort((a, b) => String(b.name).localeCompare(String(a.name)));
  }

  /**
   * 回滚：把备份里的状态文件覆盖回 state/，再让桥接重新载入内存态。
   * 回滚前会先给「当前状态」也打一份备份——否则回滚本身就成了不可逆操作。
   */
  function restoreBackup({ name, reload } = {}) {
    const safe = safeName(name);
    if (!safe || safe.includes('/') || safe.includes('\\') || safe.includes('..')) {
      return { ok: false, error: '备份名不合法' };
    }
    const dir = path.join(backupRoot, safe);
    if (!fs.existsSync(dir)) return { ok: false, error: `备份不存在：${safe}` };
    const available = fs.readdirSync(dir).filter((f) => SNAPSHOT_FILES.includes(f));
    if (!available.length) return { ok: false, error: '这个备份里没有可回滚的状态文件' };
    // 先验一遍 JSON：备份文件坏了就整份拒绝，绝不半途覆盖掉还能用的实时状态。
    for (const file of available) {
      try {
        JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      } catch (error) {
        return { ok: false, error: `备份里的 ${file} 不是合法 JSON，已中止回滚：${error?.message ?? error}` };
      }
    }

    const safety = createBackup(`rollback-before:${safe}`);
    const restored = [];
    for (const file of available) {
      try {
        fs.copyFileSync(path.join(dir, file), path.join(stateDir, file));
        restored.push(file);
      } catch (error) {
        return { ok: false, error: `恢复 ${file} 失败：${error?.message ?? error}`, safetyBackup: safety.name, restored };
      }
    }
    if (typeof reload === 'function') {
      try { reload(restored); } catch (error) { log(`[memory] 重新载入失败：${error?.message ?? error}`); }
    }
    log(`[memory] 控制台回滚备份 ${safe}：${restored.join('、')}`);
    return { ok: true, name: safe, restored, safetyBackup: safety.name, inventory: inventory() };
  }

  function backup({ reason = 'manual' } = {}) {
    const info = createBackup(reason);
    return { ok: true, backup: info, backups: listBackups().slice(0, 8) };
  }

  // ── 单条删除（控制台逐条「忘掉」）────────────────────────────────────
  function remove({ kind, key = '', id = '', id2 = '' } = {}) {
    const kindName = String(kind ?? '').trim();
    const convKey = String(key ?? '').trim();
    const target = String(id ?? '').trim();
    const second = String(id2 ?? '').trim();
    if (!kindName || !target) return { ok: false, error: 'kind 和 id 不能为空' };
    let removed = 0;

    if (kindName === MEMORY_KIND.TOPIC || kindName === MEMORY_KIND.THOUGHT) {
      const st = social?.conversations?.get?.(convKey);
      const field = kindName === MEMORY_KIND.TOPIC ? 'activeTopics' : 'pendingThoughts';
      if (st && Array.isArray(st[field])) {
        // 两种写法都认：pinId（`topic:0` / `thought:1`，控制台与钉住用的是它）和原文
        // （AI 的记忆工具、以及习惯按内容定位的调用方用的是它）。只认原文会让
        // 「页面上点忘掉」在某些调用方那里静默删不掉——这个坑踩过一次。
        const list = st[field];
        let idx = -1;
        if (/^(topic|thought):\d+$/.test(target)) {
          idx = list.findIndex((t, i) => (kindName === MEMORY_KIND.TOPIC ? topicPinId(t, i) : thoughtPinId(t, i)) === target);
        }
        if (idx < 0) idx = list.findIndex((t) => String(t?.text ?? '') === target);
        if (idx >= 0) {
          st[field] = list.filter((_, i) => i !== idx);
          removed = 1;
        }
      }
      if (removed) saveSocial();
    } else if (kindName === MEMORY_KIND.IMPRESSION) {
      const st = social?.conversations?.get?.(convKey);
      if (st?.memberImpressions && safeName(target) && st.memberImpressions[target]) {
        delete st.memberImpressions[target];
        removed = 1;
        saveSocial();
      }
    } else if (kindName === MEMORY_KIND.REMARK) {
      const list = memberStore?.conversations?.[convKey];
      if (list && list[target]) {
        delete list[target];
        removed = 1;
        saveMembers();
      }
    } else if (kindName === MEMORY_KIND.SLANG) {
      const list = getSlang() || [];
      const next = list.filter((e) => String(e?.id) !== target);
      removed = list.length - next.length;
      if (removed) setSlang(next);
    } else if (kindName === MEMORY_KIND.KNOWLEDGE) {
      const list = getKnowledge() || [];
      const next = list.filter((e) => String(e?.id) !== target);
      removed = list.length - next.length;
      if (removed) setKnowledge(next);
    } else if (kindName === MEMORY_KIND.STICKER) {
      const list = getStickers() || [];
      // 表情笔记是「本地理解」，删笔记不该把表情从收藏里删掉：只清 note/desc/tags/usage。
      let touched = 0;
      const next = list.map((e) => {
        if (String(e?.id) !== target) return e;
        touched += 1;
        return { ...e, localNote: '', tags: [], usage: '' };
      });
      removed = touched;
      if (touched) setStickers(next);
    } else if (kindName === MEMORY_KIND.CONTEXT) {
      const st = social?.conversations?.get?.(convKey);
      if (st) {
        const bucket = second === 'unread' ? 'unread' : 'recentMessages';
        const list = Array.isArray(st[bucket]) ? st[bucket] : [];
        const before = list.length;
        st[bucket] = list.filter((m) => String(m?.id ?? m?.seq ?? '') !== target);
        removed = before - st[bucket].length;
        if (removed) saveSocial();
      }
    } else {
      return { ok: false, error: `未知的记忆类型：${kindName}` };
    }

    if (removed) {
      // 删掉的东西不再需要保护：顺手把它的钉子一起摘掉，避免钉表留下死条目。
      const k = pinKey(kindName, convKey, target);
      const before = pinStore.pins.length;
      pinStore.pins = pinStore.pins.filter((p) => pinToKey(p) !== k);
      if (pinStore.pins.length !== before) savePins();
    }
    return { ok: true, removed, kind: kindName, key: convKey, id: target };
  }

  // ── 清空（按范围；默认跳过钉住的条目）────────────────────────────────
  function clear({ kind = '', key = '', category = '', includePinned = false, backup: wantBackup = true, reason = 'clear' } = {}) {
    const kindName = String(kind ?? '').trim();
    const convKey = String(key ?? '').trim();
    const cat = String(category ?? '').trim();
    if (!kindName) return { ok: false, error: 'kind 不能为空（要清哪一类记忆）' };
    const pinSet = new Set(pinStore.pins.map(pinToKey));
    const keep = (k, id, id2 = '') => !includePinned && pinSet.has(pinKey(k, id, id2));
    const snapshot = wantBackup ? createBackup(reason) : null;
    const cleared = {};
    const skipped = { pinned: 0 };
    const add = (name, n) => { if (n) cleared[name] = (cleared[name] || 0) + n; };

    const inScope = (k) => !convKey || convKey === k;

    if (kindName === MEMORY_KIND.TOPIC || kindName === MEMORY_KIND.THOUGHT || kindName === 'session' || kindName === 'all') {
      const wantTopic = kindName !== MEMORY_KIND.THOUGHT;
      const wantThought = kindName !== MEMORY_KIND.TOPIC;
      let touched = false;
      for (const k of conversationKeys()) {
        if (!inScope(k)) continue;
        const st = social?.conversations?.get?.(k);
        if (!st) continue;
        if (wantTopic && Array.isArray(st.activeTopics)) {
          const before = st.activeTopics.length;
          const kept = st.activeTopics.filter((t, i) => keep(MEMORY_KIND.TOPIC, k, topicPinId(t, i)));
          skipped.pinned += before - kept.length;
          st.activeTopics = kept;
          if (before !== kept.length) { add('topics', before - kept.length); touched = true; }
        }
        if (wantThought && Array.isArray(st.pendingThoughts)) {
          const before = st.pendingThoughts.length;
          const kept = st.pendingThoughts.filter((t, i) => keep(MEMORY_KIND.THOUGHT, k, thoughtPinId(t, i)));
          skipped.pinned += before - kept.length;
          st.pendingThoughts = kept;
          if (before !== kept.length) { add('thoughts', before - kept.length); touched = true; }
        }
      }
      if (touched) saveSocial();
    }

    if (kindName === MEMORY_KIND.IMPRESSION || kindName === 'session' || kindName === 'all') {
      let touched = false;
      for (const k of conversationKeys()) {
        if (!inScope(k)) continue;
        const st = social?.conversations?.get?.(k);
        if (!st?.memberImpressions || typeof st.memberImpressions !== 'object') continue;
        const before = Object.keys(st.memberImpressions).length;
        const next = {};
        for (const [name, im] of Object.entries(st.memberImpressions)) {
          if (keep(MEMORY_KIND.IMPRESSION, k, name)) next[name] = im;
        }
        skipped.pinned += before - Object.keys(next).length;
        st.memberImpressions = next;
        const removed = before - Object.keys(next).length;
        if (removed) { add('impressions', removed); touched = true; }
      }
      if (touched) saveSocial();
    }

    if (kindName === MEMORY_KIND.REMARK || kindName === 'session' || kindName === 'all') {
      let touched = false;
      for (const k of conversationKeys()) {
        if (!inScope(k)) continue;
        const list = memberStore?.conversations?.[k];
        if (!list || typeof list !== 'object') continue;
        const before = Object.keys(list).length;
        for (const qq of Object.keys(list)) {
          if (keep(MEMORY_KIND.REMARK, k, qq)) continue;
          delete list[qq];
        }
        const removed = before - Object.keys(list).length;
        skipped.pinned += removed;
        if (removed) { add('remarks', removed); touched = true; }
      }
      if (touched) saveMembers();
    }

    if (kindName === MEMORY_KIND.CONTEXT || kindName === MEMORY_KIND.TOPIC || kindName === MEMORY_KIND.THOUGHT || kindName === 'session' || kindName === 'all') {
      const wantRecent = kindName !== MEMORY_KIND.CONTEXT || !cat || cat === 'recent';
      const wantUnread = kindName !== MEMORY_KIND.CONTEXT || !cat || cat === 'unread';
      const wantForwards = kindName !== MEMORY_KIND.CONTEXT || !cat || cat === 'forward';
      let touched = false;
      for (const k of conversationKeys()) {
        if (!inScope(k)) continue;
        const st = social?.conversations?.get?.(k);
        if (!st) continue;
        if (kindName === 'session' || kindName === 'all') {
          if (Array.isArray(st.recentMessages) && st.recentMessages.length) { add('contextMessages', st.recentMessages.length); st.recentMessages = []; touched = true; }
          if (Array.isArray(st.unread) && st.unread.length) { add('contextMessages', st.unread.length); st.unread = []; touched = true; }
          if (Array.isArray(st.seenForwardIds) && st.seenForwardIds.length) { add('seenForwards', st.seenForwardIds.length); st.seenForwardIds = []; touched = true; }
        } else if (kindName === MEMORY_KIND.CONTEXT) {
          if (wantRecent && Array.isArray(st.recentMessages) && st.recentMessages.length) {
            add('contextMessages', st.recentMessages.length);
            st.recentMessages = [];
            touched = true;
          }
          if (wantUnread && Array.isArray(st.unread) && st.unread.length) {
            add('contextMessages', st.unread.length);
            st.unread = [];
            touched = true;
          }
          if (wantForwards && Array.isArray(st.seenForwardIds) && st.seenForwardIds.length) {
            add('seenForwards', st.seenForwardIds.length);
            st.seenForwardIds = [];
            touched = true;
          }
        }
      }
      if (touched) saveSocial();
    }

    if (kindName === MEMORY_KIND.SLANG || kindName === 'all') {
      const list = getSlang() || [];
      const next = list.filter((e) => keep(MEMORY_KIND.SLANG, '', String(e?.id)));
      skipped.pinned += list.length - next.length;
      if (next.length !== list.length) { add('slang', list.length - next.length); setSlang(next); }
    }
    if (kindName === MEMORY_KIND.KNOWLEDGE || kindName === 'all') {
      const list = getKnowledge() || [];
      const next = list.filter((e) => keep(MEMORY_KIND.KNOWLEDGE, '', String(e?.id)));
      skipped.pinned += list.length - next.length;
      if (next.length !== list.length) { add('knowledge', list.length - next.length); setKnowledge(next); }
    }
    if (kindName === MEMORY_KIND.STICKER || kindName === 'all') {
      const list = getStickers() || [];
      let touched = 0;
      const next = list.map((e) => {
        const hasNote = String(e?.localNote || '').trim() || (Array.isArray(e?.tags) && e.tags.length);
        if (!hasNote) return e;
        if (keep(MEMORY_KIND.STICKER, '', String(e?.id))) { skipped.pinned += 1; return e; }
        touched += 1;
        return { ...e, localNote: '', tags: [], usage: '' };
      });
      if (touched) { add('stickerNotes', touched); setStickers(next); }
    }

    if (!MEMORY_KINDS.includes(kindName) && kindName !== 'session' && kindName !== 'all') {
      return { ok: false, error: `未知的记忆类型：${kindName}` };
    }

    const total = Object.values(cleared).reduce((sum, n) => sum + n, 0);
    if (total) log(`[memory] 控制台清空 ${kindName}${convKey ? ` @ ${convKey}` : ''}：${JSON.stringify(cleared)}（跳过钉住 ${skipped.pinned}）`);
    return {
      ok: true,
      kind: kindName,
      key: convKey,
      cleared,
      clearedTotal: total,
      skippedPinned: skipped.pinned,
      backup: snapshot?.name || '',
      inventory: inventory()
    };
  }

  /**
   * 自然遗忘：按内容规则清理「本来就该自己消失」的记忆，而不是一刀切清空。
   * 候选条目不会被误伤（黑话/知识只有显式 kind 才动）。
   */
  function forget({ key = '', thoughtTtlMs = FORGET_DEFAULTS.thoughtTtlMs, topicIdleMs = FORGET_DEFAULTS.topicIdleMs, stickerIdleMs = FORGET_DEFAULTS.stickerIdleMs, backup: wantBackup = true } = {}) {
    const now = Date.now();
    const pinSet = new Set(pinStore.pins.map(pinToKey));
    const snapshot = wantBackup ? createBackup('forget') : null;
    const forgetResult = { thoughts: 0, topics: 0, stickerNotes: 0 };
    const skipped = { pinned: 0 };
    let touched = false;

    for (const k of conversationKeys()) {
      if (key && key !== k) continue;
      const st = social?.conversations?.get?.(k);
      if (!st) continue;
      if (Array.isArray(st.pendingThoughts)) {
        const before = st.pendingThoughts.length;
        st.pendingThoughts = st.pendingThoughts.filter((t, i) => {
          const expired = t?.expiresAt && now >= Number(t.expiresAt);
          if (!expired) return true;
          if (pinSet.has(pinKey(MEMORY_KIND.THOUGHT, k, thoughtPinId(t, i)))) { skipped.pinned += 1; return true; }
          return false;
        });
        forgetResult.thoughts += before - st.pendingThoughts.length;
        if (before !== st.pendingThoughts.length) touched = true;
      }
      if (Array.isArray(st.activeTopics)) {
        const before = st.activeTopics.length;
        st.activeTopics = st.activeTopics.filter((t, i) => {
          const idle = t?.lastMentionAt && now - Number(t.lastMentionAt) > Math.max(0, Number(topicIdleMs) || 0);
          if (!idle) return true;
          if (pinSet.has(pinKey(MEMORY_KIND.TOPIC, k, topicPinId(t, i)))) { skipped.pinned += 1; return true; }
          return false;
        });
        forgetResult.topics += before - st.activeTopics.length;
        if (before !== st.activeTopics.length) touched = true;
      }
    }
    if (touched) saveSocial();

    const idleMs = Math.max(0, Number(stickerIdleMs) || 0);
    if (idleMs > 0) {
      const list = getStickers() || [];
      let touchedSticker = 0;
      const next = list.map((e) => {
        const hasNote = String(e?.localNote || '').trim() || (Array.isArray(e?.tags) && e.tags.length);
        if (!hasNote) return e;
        const last = Number(e?.lastUsedAt) || Number(e?.updatedAt ? Date.parse(e.updatedAt) : 0) || 0;
        if (!last || now - last < idleMs) return e;
        if (pinSet.has(pinKey(MEMORY_KIND.STICKER, '', String(e?.id)))) { skipped.pinned += 1; return e; }
        touchedSticker += 1;
        return { ...e, localNote: '', tags: [], usage: '' };
      });
      if (touchedSticker) { forgetResult.stickerNotes = touchedSticker; setStickers(next); }
    }

    const total = Object.values(forgetResult).reduce((sum, n) => sum + n, 0);
    if (total) log(`[memory] 自然遗忘：${JSON.stringify(forgetResult)}（跳过钉住 ${skipped.pinned}）`);
    return { ok: true, forgotten: forgetResult, forgottenTotal: total, skippedPinned: skipped.pinned, backup: snapshot?.name || '', inventory: inventory() };
  }

  return {
    inventory,
    items,
    remove,
    clear,
    forget,
    setPin,
    backup,
    restoreBackup,
    listBackups,
    /** 供 bridge 在文件被外部改动（回滚/外部脚本）后重新读钉住表 */
    reloadPins() {
      pinStore = loadPins(pinFile);
      return pinStore.pins.length;
    },
    pinFile,
    backupRoot
  };
}
