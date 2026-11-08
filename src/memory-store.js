// 朴素记忆检索：Qwen 向量召回 + Qwen 重排。
//
// 设计刻意保持简单：
//   · 索引就是一个 JSON 文件（state/memory-index.json），每块 = 一段归档原文 + 一个向量；
//   · 召回 = 余弦相似度取前 N；重排 = 调 Qwen rerank 把前 N 重新排序；
//   · 不搞混合权重、不搞多路融合，先用最朴素的两步，效果不好再叠。
//
// 凭据：config.memory.qwen.apiKey（DashScope 兼容模式），没有就返回明确错误、由调用方回退。
import fs from 'node:fs';
import path from 'node:path';
import { localMemory } from './memory-local.js';

const DEF = {
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  rerankUrl: 'https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank',
  embedModel: 'text-embedding-v4',
  rerankModel: 'gte-rerank-v2',
  dim: 1024,
  chunkMessages: 40,
  recallN: 30,
  topK: 3
};

const __rerankCache = new Map();

const cos = (a, b) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
};

export function memoryConfig(cfg) {
  const m = cfg?.memory ?? {};
  const q = m.qwen ?? {};
  return {
    ...DEF,
    ...q,
    engine: m.engine || 'qwen',
    apiKey: String(q.apiKey || process.env.DASHSCOPE_API_KEY || '')
  };
}

/** 批量向量化（DashScope 兼容模式 /embeddings）。 */
export async function embedTexts({ texts, config, batch = 10 }) {
  const c = config || memoryConfig();
  // 本地优先：engine='local' 用本机 Qwen3-Embedding（GPU fp16）
  if (c.engine === 'local') {
    try {
      const vectors = [];
      const step = 8;
      for (let i = 0; i < texts.length; i += step) {
        const v = await localMemory.embed(texts.slice(i, i + step), { timeoutMs: 300000 });
        vectors.push(...v);
      }
      return { ok: true, vectors, model: 'Qwen3-Embedding-0.6B(local)', dim: vectors[0]?.length || 0 };
    } catch (e) {
      return { ok: false, error: `本地 embedding 失败：${e?.message ?? e}` };
    }
  }
  if (!c.apiKey) return { ok: false, error: '缺少 DashScope API Key（config.memory.qwen.apiKey）' };
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const res = await fetch(`${c.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
      body: JSON.stringify({ model: c.embedModel, input: slice, dimensions: c.dim, encoding_format: 'float' }),
      signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) return { ok: false, error: `embedding HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
    const j = await res.json();
    const rows = Array.isArray(j?.data) ? j.data.sort((a, b) => a.index - b.index) : [];
    if (rows.length !== slice.length) return { ok: false, error: 'embedding 返回条数不符' };
    for (const r of rows) out.push(r.embedding);
  }
  return { ok: true, vectors: out, model: c.embedModel, dim: out[0]?.length || 0 };
}

/** Qwen 重排：把候选按与 query 的相关性重新排序。 */
export async function rerank({ query, documents, config, topN = 3 }) {
  const c = config || memoryConfig();
  if (c.engine === 'local') {
    const ck = `${query}\u0000${documents.map((d) => String(d).slice(0, 40)).join('\u0001')}`;
    const hitc = __rerankCache.get(ck);
    if (hitc) return { ok: true, results: hitc, cached: true };
    try {
      const results = await localMemory.rerank(query, documents, topN, { timeoutMs: 120000 });
      if (__rerankCache.size > 200) __rerankCache.clear();
      __rerankCache.set(ck, results);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: `本地重排失败：${e?.message ?? e}` };
    }
  }
  if (!c.apiKey) return { ok: false, error: '缺少 DashScope API Key' };
  const res = await fetch(c.rerankUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({
      model: c.rerankModel,
      input: { query, documents },
      parameters: { return_documents: false, top_n: Math.min(topN, documents.length) }
    }),
    signal: AbortSignal.timeout(30000)
  });
  if (!res.ok) return { ok: false, error: `rerank HTTP ${res.status}：${(await res.text()).slice(0, 200)}` };
  const j = await res.json();
  const rows = j?.output?.results ?? [];
  return { ok: true, results: rows.map((r) => ({ index: r.index, score: r.relevance_score })) };
}


// ── 关键词检索（BM25）──────────────────────────────────────────────
// 中文没有空格：用「字 bigram + 英文/数字词」切，够朴素、对人名/专名也够用。
export function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  const latin = t.match(/[a-z0-9_]{2,}/g) || [];
  out.push(...latin);
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) { out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i += 1) out.push(seg.slice(i, i + 2));
  }
  return out;
}

/** 对 items 现算 BM25（几千条以内足够快，不额外维护倒排文件）。 */
export function bm25Rank({ query, items, topN = 30, k1 = 1.5, b = 0.75 }) {
  const qTokens = tokenize(query);
  if (!qTokens.length) return [];
  const docs = items.map((it) => (it.tokens ? it.tokens : tokenize(it.text)));
  const N = docs.length;
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, N);
  const df = new Map();
  for (const d of docs) {
    const seen = new Set(d);
    for (const tk of seen) df.set(tk, (df.get(tk) || 0) + 1);
  }
  const scored = [];
  for (let i = 0; i < N; i += 1) {
    const tf = new Map();
    for (const tk of docs[i]) tf.set(tk, (tf.get(tk) || 0) + 1);
    let score = 0;
    for (const tk of qTokens) {
      const f = tf.get(tk);
      if (!f) continue;
      const n = df.get(tk) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docs[i].length / avgLen)));
    }
    if (score > 0) scored.push({ index: i, score });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, topN);
}

const indexPath = (stateDir) => path.join(stateDir, 'memory-index.json');

export function loadIndex(stateDir = './state') {
  try { return JSON.parse(fs.readFileSync(indexPath(stateDir), 'utf8')); } catch { return { version: 1, model: '', dim: 0, items: [] }; }
}

export function saveIndex(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(indexPath(stateDir), JSON.stringify(data));
}

/** 从归档切块（和旧 chunk-index 同样口径：同一个会话、40 条一组）。 */
export function chunkArchive({ stateDir = './state', chunkMessages = DEF.chunkMessages, maxChunks = 20000, perMessage = true } = {}) {
  const dir = path.join(stateDir, 'messages');
  const chunks = [];
  if (!fs.existsSync(dir)) return chunks;
  for (const conv of fs.readdirSync(dir)) {
    const cdir = path.join(dir, conv);
    if (!fs.statSync(cdir).isDirectory()) continue;
    const key = conv.replace(/^group_/, 'group:').replace(/^private_/, 'private:');
    const msgs = [];
    for (const f of fs.readdirSync(cdir).filter((x) => x.endsWith('.jsonl')).sort()) {
      for (const line of fs.readFileSync(path.join(cdir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { msgs.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    }
    // 单条消息级索引（精确回原文更强）；太短的消息（"在""嗯"）跳过，省 token
    if (perMessage) {
      msgs.forEach((m, idx) => {
        const t = String(m.text || '').trim();
        if (t.length < 6) return;
        chunks.push({
          id: `${key}#m${idx}`,
          key,
          from: Number(m.t) || 0,
          to: Number(m.t) || 0,
          text: `${m.me ? '我' : m.from}: ${t.slice(0, 300)}`,
          level: 'message'
        });
      });
    }
    for (let i = 0; i < msgs.length; i += chunkMessages) {
      const slice = msgs.slice(i, i + chunkMessages);
      const text = slice.map((m) => `${m.me ? '我' : m.from}: ${String(m.text || '').slice(0, 200)}`).join('\n');
      if (text.trim().length < 40) continue;
      chunks.push({
        id: `${key}#${i}`,
        level: 'chunk',
        key,
        from: Number(slice[0]?.t) || 0,
        to: Number(slice[slice.length - 1]?.t) || 0,
        text: text.slice(0, 4000)
      });
    }
  }
  chunks.sort((a, b) => b.to - a.to);
  return chunks.slice(0, maxChunks);
}


/** 把 memory.db 的事实/知识/备注也做成可检索条目（这些才是"结论"，比原文块更值钱）。 */
export async function loadMemoryEntries({ stateDir = './state' } = {}) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(stateDir, 'memory.db'));
    const rows = db.prepare("SELECT id, kind, scope, text, answer, tags FROM items WHERE kind IN ('fact','knowledge','remark','slang')").all();
    db.close();
    return rows.map((r) => ({
      id: `mem#${r.id}`,
      key: r.scope || '__memory__',
      from: 0,
      to: 0,
      text: `[${r.kind}] ${r.text}${r.answer ? ' → ' + r.answer : ''}${r.tags ? '（' + r.tags + '）' : ''}`,
      kind: r.kind
    }));
  } catch { return []; }
}

/** 重建索引（全量）。 */
export async function rebuildIndex({ stateDir = './state', cfg = null, onProgress = null } = {}) {
  const c = memoryConfig(cfg);
  const chunks = chunkArchive({ stateDir, chunkMessages: c.chunkMessages, perMessage: c.perMessage !== false });
  const facts = await loadMemoryEntries({ stateDir });
  chunks.push(...facts);
  if (!chunks.length) return { ok: false, error: '归档里没有可索引的内容' };
  const texts = chunks.map((x) => x.text);
  const emb = await embedTexts({ texts, config: c, batch: 10 });
  if (!emb.ok) return emb;
  const items = chunks.map((x, i) => ({ ...x, vec: emb.vectors[i], tokens: tokenize(x.text) }));
  // 同一段内容只入索引一次（按规范化文本去重，保留先出现的那条）
  const seenText = new Set();
  const deduped = [];
  for (const it of items) {
    const k = String(it.text || '').replace(/\s+/g, ' ').trim();
    if (!k) continue;
    if (seenText.has(k)) continue;
    seenText.add(k);
    deduped.push(it);
  }
  saveIndex(stateDir, { version: 1, model: emb.model, dim: emb.dim, builtAt: Date.now(), items: deduped });
  onProgress?.(deduped.length);
  return { ok: true, items: deduped.length, dedupedFrom: items.length, dim: emb.dim, model: emb.model };
}


/** 查询改写：把口语问题拆成检索关键词 + 一句规范化表述（用 config.deepseek.apiKey 调 deepseek-chat）。 */
export async function rewriteQuery({ query, cfg }) {
  const key = cfg?.deepseek?.apiKey;
  const q = String(query || '').trim();
  if (!key || q.length < 3) return { ok: false, keywords: '' };
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: 'system', content: '你是检索查询改写器。只输出一行 JSON：{"keywords":"用空格分隔的 3-6 个检索关键词或人名","normalized":"一句规范化的检索句子"}。不要解释。' },
          { role: 'user', content: q.slice(0, 300) }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { ok: false, keywords: '' };
    const j = await res.json();
    const text = String(j?.choices?.[0]?.message?.content || '');
    const m = text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : {};
    return { ok: true, keywords: String(parsed.keywords || '').slice(0, 200), normalized: String(parsed.normalized || '') };
  } catch { return { ok: false, keywords: '' }; }
}

/** 召回：混合召回（向量 + BM25）→ RRF 融合 → 重排 topK。 */
export async function recall({ stateDir = './state', cfg = null, query, limit = 3, conversationKey = '' } = {}) {
  const c = memoryConfig(cfg);
  const q = String(query || '').trim();
  if (q.length < 2) return { ok: true, hits: [] };
  const idx = loadIndex(stateDir);
  if (!idx.items?.length) return { ok: false, error: '索引为空，请先重建' };

  // ① 查询改写（可选）：口语问题 → 关键词，提高召回
  let rq = { ok: false, keywords: '' };
  if (c.rewrite !== false) rq = await rewriteQuery({ query: q, cfg });
  const embedQuery = rq.ok ? [q, rq.keywords].filter(Boolean).join(' ') : q;
  const bmQuery = rq.ok && rq.keywords ? rq.keywords : q;

  const qemb = await embedTexts({ texts: [embedQuery.slice(0, 500)], config: c, batch: 1 });
  if (!qemb.ok) return qemb;
  const qv = qemb.vectors[0];

  // ② 向量召回
  const vec = idx.items.map((it, i) => ({
    i,
    score: cos(qv, it.vec) + (conversationKey && it.key === conversationKey ? 0.05 : 0)
  })).sort((a, b) => b.score - a.score).slice(0, c.recallN);

  // ③ BM25 召回 → RRF 融合（k=60）
  const bm = c.hybrid === false ? [] : bm25Rank({ query: bmQuery, items: idx.items, topN: c.recallN });
  const fused = new Map();
  vec.forEach((v, rank) => fused.set(v.i, { i: v.i, rrf: 1 / (60 + rank + 1), vec: v.score, bm: 0 }));
  bm.forEach((b, rank) => {
    const cur = fused.get(b.index) || { i: b.index, rrf: 0, vec: 0, bm: 0 };
    cur.rrf += 1 / (60 + rank + 1);
    cur.bm = b.score;
    fused.set(b.index, cur);
  });
  const cand = [...fused.values()].sort((a, b) => b.rrf - a.rrf).slice(0, c.recallN);
  if (!cand.length) return { ok: true, hits: [] };

  let hits = cand.slice(0, limit).map((x) => ({ ...idx.items[x.i], vec: undefined, tokens: undefined, score: x.vec, bm25: x.bm }));
  let reranked = false;
  try {
    const rr = await rerank({ query: embedQuery.slice(0, 500), documents: cand.map((x) => idx.items[x.i].text), config: c, topN: limit });
    if (rr.ok && rr.results.length) {
      hits = rr.results.map((r) => {
        const x = cand[r.index];
        return { ...idx.items[x.i], vec: undefined, tokens: undefined, score: r.score, vecScore: x.vec, bm25: x.bm };
      });
      reranked = true;
    }
  } catch { /* 重排失败就用融合排序 */ }
  return { ok: true, hits, reranked, candidates: cand.length, rewritten: rq.ok ? rq.keywords : '' };
}

export function summarizeHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const fmt = (t) => new Date(Number(t) || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return hits.map((h) => `【${fmt(h.from)}~${fmt(h.to)} · ${h.key}】${String(h.text).slice(0, 500)}`).join('\n');
}
