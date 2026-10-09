// 主题探索（自主扩展学习）：给一个种子关键词，让 AI 自己去网上把这一圈的东西学回来。
//
// 场景（管理员在控制台输入，或 AI 用 qq_explore_topic 发起）：
//   mygo → 弄清它是什么、里面有哪些梗 → 再顺着关联把 Ave Mujica / 夢限大みゅーたいぷ
//   这些同圈子的东西作为下一批种子继续挖 → 挖到的梗进黑话库、主题综述进知识库。
//
// 设计要点：
// - **纯函数 + 不 import 桥接**：提示词组装、JSON 解析、队列/预算/去重全在这里，
//   编排（建会话、投 prompt、落库）留在 bridge.js。这样这套逻辑能在临时目录里单测。
// - **防膨胀**：深度 + 主题总数双上限，队列里一次最多排队多少条也封顶。
//   一个热门企划的关联词能无限发散（同人、CV、二创、梗图社区…），没有上限就会烧光 token。
// - **去重按规范化 key**：`mygo` / `MyGO!!!!!` / `my go` 算同一个主题，否则会反复挖同一个。
// - **解析必须容错**：模型经常把 JSON 包在 ``` 里、或在前后写一句人话，这里都当正常输入处理；
//   解析不出来就返回 null 让调用方如实记失败，绝不编造学习结果。

export const TOPIC_NAME_MAX = 60;
export const TOPIC_SUMMARY_MAX = 500;
export const TOPIC_KIND_MAX = 40;
export const MAX_TERMS_PER_TOPIC = 12;
export const MAX_RELATED_PER_TOPIC = 8;
export const MAX_QUEUE = 60;
export const TERM_MEANING_MAX = 300;
export const TERM_EXAMPLE_MAX = 160;
export const TERM_USAGE_MAX = 200;
export const TERM_RISK_MAX = 80;

/** 主题去重用的规范化 key：大小写/空白/全角/标点都不算区别（`MyGO!!!!!` → `mygo`）。 */
export function normalizeTopicKey(name) {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!！?？。.、,，:：;；'"“”‘’`()[\]{}【】<>《》·~～\-_/\\|*#@+]+/g, '')
    .slice(0, TOPIC_NAME_MAX);
}

function clampText(value, max) {
  return String(value ?? '')
    // 控制字符 + 零宽字符会把 prompt/JSON 弄脏，统一压成空格
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 围栏、前后夹带说明文字）。 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  for (const candidate of candidates) {
    const src = String(candidate ?? '').trim();
    if (!src) continue;
    try {
      const parsed = JSON.parse(src);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* 继续尝试截取 */ }
    const start = src.indexOf('{');
    const end = src.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(src.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* 放弃 */ }
    }
  }
  return null;
}

/** 规范化一个主题对象；名字为空视为无效。 */
export function normalizeTopic(raw, fallbackName = '') {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const name = clampText(obj.name ?? obj.topic ?? fallbackName, TOPIC_NAME_MAX);
  if (!name) return null;
  const aliases = (Array.isArray(obj.aliases) ? obj.aliases : [])
    .map((a) => clampText(a, TOPIC_NAME_MAX))
    .filter(Boolean)
    .slice(0, 6);
  return {
    name,
    key: normalizeTopicKey(name),
    kind: clampText(obj.kind ?? obj.type ?? '', TOPIC_KIND_MAX),
    summary: clampText(obj.summary ?? obj.desc ?? obj.description ?? '', TOPIC_SUMMARY_MAX),
    aliases
  };
}

/** 规范化一条「梗 / 黑话」；只保留有词条名的，最多 MAX_TERMS_PER_TOPIC 条。 */
export function normalizeDiscoveredTerms(rawTerms) {
  const list = Array.isArray(rawTerms) ? rawTerms : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const obj = item && typeof item === 'object' ? item : (typeof item === 'string' ? { content: item } : null);
    if (!obj) continue;
    const content = clampText(obj.content ?? obj.term ?? obj.name ?? '', TOPIC_NAME_MAX);
    if (!content) continue;
    const key = normalizeTopicKey(content);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const sources = (Array.isArray(obj.sources) ? obj.sources : [])
      .map((s) => String(s ?? '').trim())
      .filter((s) => /^https?:\/\//i.test(s))
      .slice(0, 6);
    out.push({
      content,
      meaning: clampText(obj.meaning ?? '', TERM_MEANING_MAX),
      usage: clampText(obj.usage ?? '', TERM_USAGE_MAX),
      example: clampText(obj.example ?? '', TERM_EXAMPLE_MAX),
      risk: clampText(obj.risk ?? '', TERM_RISK_MAX),
      sources,
      // 模型自评「这是真的网络用法」才为 true；不确定一律 false。
      confirmed: obj.confirmed === true
    });
    if (out.length >= MAX_TERMS_PER_TOPIC) break;
  }
  return out;
}

/** 规范化一条「关联主题」；priority 越小越先挖（缺省按出现顺序）。 */
export function normalizeRelatedTopics(rawRelated, { excludeKeys = [] } = {}) {
  const list = Array.isArray(rawRelated) ? rawRelated : [];
  const excluded = new Set(excludeKeys.filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const obj = item && typeof item === 'object' ? item : (typeof item === 'string' ? { name: item } : null);
    if (!obj) continue;
    const name = clampText(obj.name ?? obj.topic ?? obj.content ?? '', TOPIC_NAME_MAX);
    if (!name) continue;
    const key = normalizeTopicKey(name);
    if (!key || seen.has(key) || excluded.has(key)) continue;
    seen.add(key);
    const rawPriority = Number(obj.priority);
    out.push({
      name,
      key,
      why: clampText(obj.why ?? obj.reason ?? obj.relation ?? '', 120),
      priority: Number.isFinite(rawPriority) ? rawPriority : out.length
    });
    if (out.length >= MAX_RELATED_PER_TOPIC) break;
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/**
 * 解析一次主题研究的模型输出。
 * @returns {{topic:object, terms:object[], related:object[]}|null} null = 解析失败（调用方如实记失败）
 */
export function parseTopicResearchJson(text, { fallbackName = '' } = {}) {
  const obj = extractJsonObject(text);
  if (!obj) return null;
  const topicRaw = obj.topic && typeof obj.topic === 'object' ? obj.topic : obj;
  const topic = normalizeTopic(topicRaw, fallbackName);
  if (!topic) return null;
  return {
    topic,
    terms: normalizeDiscoveredTerms(obj.terms ?? obj.slang ?? obj.memes),
    related: normalizeRelatedTopics(obj.related ?? obj.relatedTopics ?? obj.seeAlso, { excludeKeys: [topic.key] })
  };
}

/**
 * 主题研究的提示词。
 *
 * 输出契约写得很死（固定 JSON、字段名、数量上限），因为下游要直接落库；
 * 模型自由发挥的话解析成功率会明显下降。同样重要的是**明确要求带 sources**：
 * 学习结果会自动 confirmed 直接进提示词，没有来源的释义等于让模型随便编。
 */
export function buildTopicResearchPrompt({ name, why = '', depth = 0, seed = '', knownTopics = [], knownTerms = [] } = {}) {
  const knownTopicKeys = new Set(knownTopics.map((t) => normalizeTopicKey(t)));
  const knownTermKeys = new Set(knownTerms.map((t) => normalizeTopicKey(t)));
  const lines = [];
  lines.push('你是网络文化研究员，负责把一个圈子/作品/企划的「梗」摸清楚，供群聊机器人后续使用。');
  lines.push('全程只做只读操作：用 mcp__web-search-safe__web_search 搜、web_fetch / web_render 读正文；不要执行任何本地操作。');
  lines.push('**不要只依赖搜索摘要**：至少读 1~2 篇最相关的正文（百科、萌娘百科、B站专栏/视频简介、贴吧/知乎高赞都行）。');
  lines.push('');
  lines.push(`【本次要摸的主题】${name}`);
  if (why) lines.push(`【它是怎么被关联进来的】${why}`);
  if (seed && depth > 0) lines.push(`【本次探索的起点】${seed}（这是第 ${depth} 层关联）`);
  lines.push('');
  if (knownTopicKeys.has(normalizeTopicKey(name))) {
    lines.push('（这个主题之前已经探过，本次请重点补充遗漏的梗与关联，不要重复已有内容。）');
    lines.push('');
  }
  lines.push('【输出格式】只输出一个 JSON 对象，不要写任何解释文字、不要用 Markdown 代码块以外的包装：');
  lines.push('{');
  lines.push('  "topic": {');
  lines.push('    "name": "主题的规范名（例如 mygo 的规范名是 MyGO!!!!!）",');
  lines.push('    "kind": "这是什么（作品/企划/乐队/游戏/社区/人物/事件…）",');
  lines.push('    "summary": "两三句话说清它是什么、为什么会有这些梗（300 字内）",');
  lines.push('    "aliases": ["常见别名/叫法"]');
  lines.push('  },');
  lines.push('  "terms": [');
  lines.push('    {');
  lines.push('      "content": "梗/黑话的原文（群友会怎么写它就怎么写）",');
  lines.push('      "meaning": "它在群聊里到底什么意思（必须基于真实用法，不要望文生义）",');
  lines.push('      "usage": "什么语境下用（可选）",');
  lines.push('      "example": "一个自然的短句示例（可选）",');
  lines.push('      "risk": "有没有敏感/慎用风险（没有就留空）",');
  lines.push('      "sources": ["真实读过的来源 URL"],');
  lines.push('      "confirmed": true');
  lines.push('    }');
  lines.push('  ],');
  lines.push('  "related": [');
  lines.push('    { "name": "关联的主题名", "why": "和本主题什么关系", "priority": 1 }');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('【硬性要求】');
  lines.push(`- terms 最多 ${MAX_TERMS_PER_TOPIC} 条，related 最多 ${MAX_RELATED_PER_TOPIC} 条；宁少勿滥。`);
  lines.push('- 每条 term 的 sources 必须是你**真的抓取过**的 URL；一条都没读到就把该条的 confirmed 设为 false。');
  lines.push('- 搜不到、或拿不准是不是真梗的，confirmed 设为 false，别编；绝不臆造含义。');
  lines.push('- 跳过这些（已经学过了，别重复占额度）：');
  if (knownTermKeys.size) {
    const sample = [...knownTermKeys].slice(0, 40).join('、');
    lines.push(`  - 已知词条：${sample}`);
  } else {
    lines.push('  - （暂无已知词条）');
  }
  lines.push('- related 用来「继续挖」：同一企划的姊妹作品、同圈子的其他梗、强相关的社区都能放，但必须真有关系。');
  lines.push('- 只输出 JSON。');
  return lines.join('\n');
}

// ── 任务（job）与队列：纯函数 ─────────────────────────────────────────────

export function createExploreJob({ seed, maxDepth = 2, maxTopics = 15, now = Date.now() } = {}) {
  const name = clampText(seed, TOPIC_NAME_MAX);
  if (!name) throw new Error('种子关键词不能为空');
  return {
    id: `exp-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seed: name,
    status: 'pending',           // pending | running | done | stopped | failed
    createdAt: now,
    updatedAt: now,
    maxDepth: Math.max(0, Math.min(4, Math.round(Number(maxDepth) || 0))),
    maxTopics: Math.max(1, Math.min(60, Math.round(Number(maxTopics) || 1))),
    // 待挖队列（按 priority 排序消费）
    queue: [{ name, key: normalizeTopicKey(name), depth: 0, why: '种子关键词', priority: 0 }],
    visited: [],                 // [{ name, key, depth, kind, summary, terms, related, at, sources }]
    stats: { topics: 0, terms: 0, confirmed: 0, related: 0, failed: 0 },
    error: '',
    log: []
  };
}

/** 该 job 是否已到主题总数上限。 */
export function jobExhausted(job) {
  return (job?.visited?.length ?? 0) >= (job?.maxTopics ?? 0);
}

/**
 * 取下一个要挖的主题（不出队，交给 markTopicVisited 处理）。
 * 跳过已访问过的 key（同一主题可能被多条关联重复指向）。
 */
export function peekNextTopic(job) {
  if (!job || jobExhausted(job)) return null;
  const visited = new Set((job.visited ?? []).map((v) => v.key));
  const queue = [...(job.queue ?? [])].sort((a, b) => (a.depth - b.depth) || (a.priority - b.priority));
  for (const item of queue) {
    if (item && item.key && !visited.has(item.key)) return item;
  }
  return null;
}

/** 出队一个主题（按 key 移除；同 key 的重复条目一并清掉）。 */
export function shiftTopic(job, key) {
  if (!job || !Array.isArray(job.queue)) return null;
  const idx = job.queue.findIndex((t) => t && t.key === key);
  if (idx < 0) return null;
  const [item] = job.queue.splice(idx, 1);
  job.queue = job.queue.filter((t) => t && t.key !== key);
  return item;
}

/**
 * 把一批关联主题加进队列。
 * 三道闸：深度不超 maxDepth、总数不超 maxTopics、队列不超 MAX_QUEUE；
 * 再加上已访问/已在队列/本批内去重 —— 热门企划的关联能无限发散，没有这些会烧光 token。
 */
export function enqueueRelatedTopics(job, related, childDepth, { now = Date.now() } = {}) {
  if (!job || !Array.isArray(related) || !related.length) return [];
  if (childDepth > (job.maxDepth ?? 0)) return [];
  const visitedKeys = new Set((job.visited ?? []).map((v) => v.key));
  const queuedKeys = new Set((job.queue ?? []).map((t) => t.key));
  // 预算 = 还能再装几个主题：总数上限扣掉「已访问 + 已在队列」，再受队列硬上限约束。
  let room = Math.max(0, (job.maxTopics ?? 0) - (job.visited?.length ?? 0) - (job.queue?.length ?? 0));
  room = Math.min(room, Math.max(0, MAX_QUEUE - (job.queue?.length ?? 0)));
  const added = [];
  for (const item of related) {
    if (room <= 0) break;
    if (!item?.key) continue;
    if (visitedKeys.has(item.key) || queuedKeys.has(item.key)) continue;
    queuedKeys.add(item.key);
    added.push({ name: item.name, key: item.key, depth: childDepth, why: item.why, priority: item.priority ?? added.length });
    room -= 1;
  }
  job.queue.push(...added);
  job.updatedAt = now;
  return added;
}

/** 记一次主题访问结果（成功后调用）。 */
export function markTopicVisited(job, { name, key, depth, topic, terms, related, now = Date.now() }) {
  if (!job) return;
  const visit = {
    name: topic?.name || name,
    key: key || normalizeTopicKey(name),
    depth: Number(depth) || 0,
    kind: topic?.kind ?? '',
    summary: topic?.summary ?? '',
    aliases: topic?.aliases ?? [],
    terms: Array.isArray(terms) ? terms.map((t) => t.content) : [],
    related: Array.isArray(related) ? related.map((r) => r.name) : [],
    at: now
  };
  job.visited.push(visit);
  job.stats.topics = job.visited.length;
  job.stats.terms += visit.terms.length;
  job.stats.confirmed += Array.isArray(terms) ? terms.filter((t) => t.confirmed).length : 0;
  job.stats.related += visit.related.length;
  job.updatedAt = now;
  return visit;
}

/** 追加一行进度日志（有界，控制台只展示最近若干条）。 */
export function appendJobLog(job, text, { now = Date.now(), max = 100 } = {}) {
  if (!job) return;
  if (!Array.isArray(job.log)) job.log = [];
  job.log.push({ at: now, text: clampText(text, 300) });
  if (job.log.length > max) job.log.splice(0, job.log.length - max);
}

/** 反序列化（持久化回来的 job 做一次归一化，防止旧版本/损坏字段把编排逻辑弄崩）。 */
export function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const seed = clampText(raw.seed, TOPIC_NAME_MAX);
  if (!seed) return null;
  const job = createExploreJob({ seed, maxDepth: raw.maxDepth, maxTopics: raw.maxTopics, now: Number(raw.createdAt) || Date.now() });
  job.id = String(raw.id || job.id);
  job.status = ['pending', 'running', 'done', 'stopped', 'failed'].includes(raw.status) ? raw.status : 'pending';
  job.updatedAt = Number(raw.updatedAt) || job.createdAt;
  job.error = clampText(raw.error, 300);
  job.queue = (Array.isArray(raw.queue) ? raw.queue : [])
    .map((t) => (t && t.name ? {
      name: clampText(t.name, TOPIC_NAME_MAX),
      key: normalizeTopicKey(t.name),
      depth: Math.max(0, Math.round(Number(t.depth) || 0)),
      why: clampText(t.why, 120),
      priority: Number.isFinite(Number(t.priority)) ? Number(t.priority) : 0
    } : null))
    .filter(Boolean)
    .slice(0, MAX_QUEUE);
  job.visited = (Array.isArray(raw.visited) ? raw.visited : [])
    .map((v) => (v && v.key ? {
      name: clampText(v.name, TOPIC_NAME_MAX),
      key: String(v.key),
      depth: Math.max(0, Math.round(Number(v.depth) || 0)),
      kind: clampText(v.kind, TOPIC_KIND_MAX),
      summary: clampText(v.summary, TOPIC_SUMMARY_MAX),
      aliases: Array.isArray(v.aliases) ? v.aliases.map((a) => clampText(a, TOPIC_NAME_MAX)).filter(Boolean).slice(0, 6) : [],
      terms: Array.isArray(v.terms) ? v.terms.map(String).slice(0, MAX_TERMS_PER_TOPIC * 2) : [],
      related: Array.isArray(v.related) ? v.related.map(String).slice(0, MAX_RELATED_PER_TOPIC * 2) : [],
      at: Number(v.at) || 0
    } : null))
    .filter(Boolean)
    .slice(0, 200);
  const st = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  job.stats = {
    topics: job.visited.length,
    terms: Number(st.terms) || 0,
    confirmed: Number(st.confirmed) || 0,
    related: Number(st.related) || 0,
    failed: Number(st.failed) || 0
  };
  job.log = (Array.isArray(raw.log) ? raw.log : [])
    .map((l) => (l && l.text ? { at: Number(l.at) || 0, text: clampText(l.text, 300) } : null))
    .filter(Boolean)
    .slice(-100);
  return job;
}

/** 给控制台/AI 看的一行进度。 */
export function formatJobProgress(job) {
  if (!job) return '';
  const names = (job.visited ?? []).map((v) => v.name);
  return `${job.seed}：${job.status}｜已探 ${job.stats.topics}/${job.maxTopics} 个主题`
    + `｜梗 ${job.stats.terms} 条（确认 ${job.stats.confirmed}）`
    + `｜队列剩 ${job.queue?.length ?? 0}`
    + (names.length ? `｜已学：${names.slice(0, 8).join('、')}${names.length > 8 ? '…' : ''}` : '');
}
