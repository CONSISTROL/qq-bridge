// 群知识库 —— 状态存储与去重匹配（纯函数 + JSON 落盘，不依赖 bridge）。
//
// 与黑话库（src/slang-learner.js）的关系：
//   * 黑话库管「词是什么意思」；知识库管「问题→答案」，即群友反复问到的客观事实与群内约定。
//   * 两者共用一套向量索引（src/slang-index.js），因为 entryText/entryHash 只认 content/meaning，
//     而知识库把 question 映射到 content、answer 映射到 meaning，于是打分与检索逻辑完全复用。
//
// 设计要点：
//   * **问题指纹去重**：同一个人换着说法问同一个问题（「DeepSeek 什么时候开源的」「ds 开源时间」）
//     要能命中同一条。指纹 = 去空白/标点、小写、剥掉疑问语气词；指纹相同 → 直接命中。
//   * **近重复兜底**：指纹不同但字面高度重叠（bigram Jaccard）时也算命中，避免「多打两个字就新开一条」。
//   * **命中计数**：hitCount / askers 记「被问过多少次、几个人问的」，供唤醒提示按阈值提醒。
//   * **全自动写入但可删改**：AI 提交即入库生效（status=confirmed），同时把「与已有条目语义冲突」
//     的写入标记成 conflict，控制台可一眼看到并人工裁定。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 三种状态，与黑话库（slang-learner）保持同一套语义：
//   candidate = 待人工确认（不进注入池、不参与向量检索）
//   confirmed = 已生效（会被检索并注入）
//   archived  = 人工停用（内容留着，但同样不生效）
export const KNOWLEDGE_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  ARCHIVED: 'archived',
});

export const KNOWLEDGE_STATUSES = Object.freeze([
  KNOWLEDGE_STATUS.CANDIDATE,
  KNOWLEDGE_STATUS.CONFIRMED,
  KNOWLEDGE_STATUS.ARCHIVED,
]);

/** 只有「已生效」才参与检索与注入。candidate/archived 都不算。 */
export function isActiveStatus(status) {
  return status === KNOWLEDGE_STATUS.CONFIRMED;
}

/** 知识类型：用 tags 里的第一个「类型标签」区分事实/群规/人物。 */
export const KNOWLEDGE_KINDS = Object.freeze({
  FACT: 'fact',     // 客观事实（版本、时间、价格、原理……）
  RULE: 'rule',     // 群内约定/规矩（禁刷屏、求助格式……）
  PERSON: 'person', // 群内人物/称呼指代（管理员是谁、马头指谁……）
  HOWTO: 'howto',   // 操作步骤（怎么改名片、怎么申请头衔……）
});

export const DEFAULT_KINDS = Object.freeze([
  KNOWLEDGE_KINDS.FACT,
  KNOWLEDGE_KINDS.RULE,
  KNOWLEDGE_KINDS.PERSON,
  KNOWLEDGE_KINDS.HOWTO,
]);

export const QUESTION_MAX = 200;
export const ANSWER_MAX = 2000;

export function nowIso() {
  return new Date().toISOString();
}

export function createId() {
  return 'k' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/**
 * 问题指纹：把「同一件事的不同问法」收敛到同一个字符串。
 * 只做确定性归一化（不做同义词替换，那需要模型且会引入不确定性）。
 * 分三步：统一字符 → 剥掉疑问填充词/语气词 → 同义疑问词归一。
 */
export function questionFingerprint(question) {
  let s = String(question ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // 去掉所有空白与标点（中英文），只留实义字符
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~\u3001-\u303f\uff01-\uff5e\u2018\u2019\u201c\u201d]/g, '');

  // 第一步：删掉句中的「疑问填充词」——它们不改变问题指向，只是措辞。
  // 注意按长度从长到短删，避免「是什么」先于「是什么时候」命中而留下残渣。
  const fillers = [
    '是什么时候', '什么时候', '是几号', '是哪一位', '是哪个', '是哪位', '是啥', '是什么', '是哪个',
    '在哪儿', '在哪里', '在哪个', '怎么才能', '怎么样才能', '怎么办', '怎么弄', '怎么搞', '咋办',
    '多少钱', '多少个', '多少次', '多长时间', '有多长', '能不能', '可不可以', '是不是', '有没有',
    '一下子', '一下', '一位', '一个', '哪些', '哪个', '哪些', '多少', '多久', '几位', '几个',
    '请', '问', '一下',
  ].sort((a, b) => b.length - a.length);
  for (const f of fillers) {
    if (!f) continue;
    s = s.split(f).join('');
  }

  // 第二步：剥掉首尾的客套前缀与语气助词。
  const prefixes = ['请问', '想问一下', '问一下', '有人知道', '谁知道', '求问', '求解', '求'];
  const suffixes = ['是什么意思', '怎么办', '吗', '呢', '啊', '呀', '嘛', '吧', '的', '了', '哦', '噢', '喔', '啦', '咯', '么', '哈'];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (s.length > p.length && s.startsWith(p)) { s = s.slice(p.length); changed = true; }
    }
    for (const suf of suffixes) {
      if (s.length > suf.length && s.endsWith(suf)) { s = s.slice(0, -suf.length); changed = true; }
    }
  }

  // 第三步：同义疑问词归一（只做「问的是同一件事、只是用词不同」的等价类）。
  const synonyms = [
    [['何时', '哪年', '哪一年', '几时', '哪时候'], '何时'],
    [['多少钱', '价格', '售价', '价位'], '价格'],
    [['几人', '多少人'], '人数'],
    [['能否', '可否', '可以吗'], '可否'],
  ];
  for (const [variants, canonical] of synonyms) {
    for (const v of variants) {
      if (s.includes(v)) { s = s.split(v).join(canonical); }
    }
  }
  return s;
}

/** 字符 bigram 集合，用于近重复判定与相似度。 */
export function bigrams(text) {
  const s = questionFingerprint(text);
  const out = new Set();
  if (s.length <= 1) { if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 同上，但接受已归一化好的指纹，避免重复计算。 */
function bigramsOfFingerprint(fp) {
  const out = new Set();
  if (fp.length <= 1) { if (fp) out.add(fp); return out; }
  for (let i = 0; i < fp.length - 1; i++) out.add(fp.slice(i, i + 2));
  return out;
}

/**
 * 两个问题的相似度。
 * 单用 bigram Jaccard 对中文短句太苛刻：只差一两个字（「股市」↔「大盘」）就掉到 0.33，
 * 而这类恰恰是最该合并的近重复。所以混入编辑距离相似度（Levenshtein ratio），
 * 再用两者的较大值——Jaccard 管语序，编辑距离管少量替换。
 */
export function questionSimilarity(a, b) {
  const fa = questionFingerprint(a);
  const fb = questionFingerprint(b);
  if (!fa || !fb) return 0;
  if (fa === fb) return 1;
  const A = bigramsOfFingerprint(fa);
  const B = bigramsOfFingerprint(fb);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = A.size + B.size - inter;
  const jaccard = union ? inter / union : 0;
  return Math.max(jaccard, levenshteinRatio(fa, fb));
}

/** 编辑距离相似度 1 - dist/maxLen（滚动数组，长度不敏感）。 */
export function levenshteinRatio(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  const n = s.length;
  const m = t.length;
  if (!n || !m) return 0;
  let prev = new Array(m + 1);
  let cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  return 1 - prev[m] / Math.max(n, m);
}

function normalizeKind(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return DEFAULT_KINDS.includes(v) ? v : '';
}

export function normalizeKnowledgeEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const status = KNOWLEDGE_STATUSES.includes(entry.status) ? entry.status : KNOWLEDGE_STATUS.CANDIDATE;
  const tags = Array.isArray(entry.tags)
    ? [...new Set(entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean))].slice(0, 8)
    : [];
  const kind = normalizeKind(entry.kind) || normalizeKind(tags[0]) || KNOWLEDGE_KINDS.FACT;
  const askers = Array.isArray(entry.askers)
    ? [...new Set(entry.askers.map((a) => String(a ?? '').trim()).filter(Boolean))].slice(0, 50)
    : [];
  const question = String(entry.question ?? entry.content ?? '').trim().slice(0, QUESTION_MAX);
  const answer = String(entry.answer ?? entry.meaning ?? '').trim().slice(0, ANSWER_MAX);
  return {
    id: String(entry.id || createId()),
    question,
    answer,
    aliases: Array.isArray(entry.aliases)
      ? [...new Set(entry.aliases.map((a) => String(a ?? '').trim()).filter(Boolean))].slice(0, 12)
      : [],
    kind,
    tags: [...new Set([kind, ...tags])].slice(0, 8),
    sources: Array.isArray(entry.sources) ? entry.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(-10) : [],
    status,
    source: entry.source === 'manual' ? 'manual' : 'ai',
    confidence: entry.confidence === 'low' ? 'low' : 'normal',
    hitCount: Math.max(0, Number(entry.hitCount ?? entry.count) || 0),
    // 答案被更新过几次。知识条目是该「不断更新」的，有个计数才能在控制台一眼看出
    // 哪条被反复修正过（可能一直没答对），又不至于像存全文历史那样把 state 文件撑大。
    revision: Math.max(0, Number(entry.revision) || 0),
    askers,
    evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(-20) : [],
    conflict: entry.conflict && typeof entry.conflict === 'object' ? entry.conflict : null,
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso()),
  };
}

/** 供通用向量索引复用的适配器：question→content、answer→meaning。 */
export function asIndexEntry(entry) {
  return {
    id: entry.id,
    content: entry.question,
    meaning: entry.answer,
    usage: '',
  };
}

export function loadKnowledge(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.entries) ? parsed.entries : []);
    return list.map(normalizeKnowledgeEntry).filter((e) => e.question && e.answer);
  } catch {
    return [];
  }
}

export function saveKnowledge(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createKnowledgeEntry(input = {}) {
  const base = normalizeKnowledgeEntry({
    ...input,
    id: input.id || createId(),
    hitCount: input.hitCount ?? 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  // 新条目的 askers 默认包含首个提问者（若有）
  if (input.asker && !base.askers.includes(String(input.asker))) base.askers.push(String(input.asker));
  return base;
}

/**
 * 找已存在的同义条目。
 * 顺序：指纹完全一致 → 别名一致 → 字面相似度超过阈值。
 * @returns {{entry:object, match:'fingerprint'|'alias'|'similar', sim?:number}|null}
 */
// 阈值 0.62：实测「群里能不能发广告」vs「群里可以发广告吗」= 0.50，
// 「DeepSeek 什么时候开源」vs「ds 开源时间是」≈ 0.4。定太高会把真·同义改写漏成两条，
// 定太低又会让短问句（bigram 少）互相误并。0.62 是两条真实样本之间的折中，
// 且宁可漏并（多一条可人工合并）也不要误并（答案被张冠李戴）。
export function findKnowledgeMatch(entries, question, { similarityThreshold = 0.62 } = {}) {
  const fp = questionFingerprint(question);
  if (!fp) return null;
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (questionFingerprint(e.question) === fp) return { entry: e, match: 'fingerprint' };
  }
  const lower = fp;
  for (const e of list) {
    for (const alias of (e.aliases || [])) {
      if (questionFingerprint(alias) === lower) return { entry: e, match: 'alias' };
    }
  }
  let best = null;
  for (const e of list) {
    const sim = questionSimilarity(e.question, question);
    if (sim >= similarityThreshold && (!best || sim > best.sim)) best = { entry: e, match: 'similar', sim };
  }
  return best;
}

/** 记一次命中：+1 计数、追加提问者、追加证据。 */
export function recordHit(entry, { key = '', asker = '', text = '', time = Date.now() } = {}) {
  entry.hitCount = (Number(entry.hitCount) || 0) + 1;
  const a = String(asker || '').trim();
  if (a && !entry.askers.includes(a)) entry.askers.push(a);
  if (key || text) {
    const ev = { key, asker: a || '未知', text: String(text || '').slice(0, 200), time };
    const seen = new Set(entry.evidence.map((x) => JSON.stringify(x)));
    if (!seen.has(JSON.stringify(ev))) entry.evidence.push(ev);
    entry.evidence = entry.evidence.slice(-20);
  }
  entry.updatedAt = nowIso();
  return entry;
}

/**
 * 命中提醒阈值判定：被问到够多次、且涉及多个不同的人，才提醒 AI「该沉淀答案了」。
 * 单个人反复问同一条不算（那是他个人没记住，不是群级 FAQ）。
 */
export function shouldRemindRepeat(entry, threshold = 3, minAskers = 2) {
  const hits = Number(entry?.hitCount) || 0;
  const askers = Array.isArray(entry?.askers) ? entry.askers.length : 0;
  return hits >= threshold && askers >= minAskers;
}

function kindLabel(kind) {
  switch (kind) {
    case KNOWLEDGE_KINDS.RULE: return '群规';
    case KNOWLEDGE_KINDS.PERSON: return '人物';
    case KNOWLEDGE_KINDS.HOWTO: return '操作';
    default: return '事实';
  }
}

function clean(s) {
  return String(s ?? '')
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 渲染注入用的知识表。与黑话表分成两块，避免混在一起让 AI 分不清「词义」和「答案」。
 * @param {Array} list 已选定的条目
 * @param {object} opts
 * @param {number} opts.remindThreshold 命中次数达到多少时附上「已被问过 N 次」提醒
 */
export function formatKnowledgeTable(list, { remindThreshold = 3 } = {}) {
  const rows = (list || []).filter((e) => e && e.question && e.answer);
  if (!rows.length) return '';
  const lines = rows.map((e) => {
    const tags = (e.tags || []).filter((t) => t !== e.kind).slice(0, 3);
    const src = (e.sources || []).length ? `（来源：${clean(e.sources[e.sources.length - 1])}）` : '';
    let line = `- [${kindLabel(e.kind)}] ${clean(e.question)} → ${clean(e.answer)}${src}`;
    if (tags.length) line += `（标签：${tags.map(clean).join('、')}）`;
    if (shouldRemindRepeat(e, remindThreshold)) {
      line += `\n  ↳ 这条已被问过 ${e.hitCount} 次（${e.askers.length} 个不同的人），直接照上面的答案回，别再重新查/重新编。`;
    }
    return line;
  });
  return `【群知识库】群友以前问过、已有确定答案的问题（与当前话题相关者优先；有答案就直接用，别重复考据；答案与事实不符时以你的查证为准并更新它）：\n${lines.join('\n')}`;
}

/** 按命中次数取 top-N 渲染（未启用向量检索或检索失败时的兜底路径）。 */
export function buildKnowledgeContext(entries, max = 6, opts = {}) {
  const confirmed = (entries || [])
    .filter((e) => e.status === KNOWLEDGE_STATUS.CONFIRMED && e.question && e.answer)
    .sort((a, b) => (Number(b.hitCount) || 0) - (Number(a.hitCount) || 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 6)));
  return formatKnowledgeTable(confirmed, opts);
}
