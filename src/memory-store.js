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

const indexPath = (stateDir) => path.join(stateDir, 'memory-index.json');

export function loadIndex(stateDir = './state') {
  try { return JSON.parse(fs.readFileSync(indexPath(stateDir), 'utf8')); } catch { return { version: 1, model: '', dim: 0, items: [] }; }
}

export function saveIndex(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(indexPath(stateDir), JSON.stringify(data));
}

/** 从归档切块（和旧 chunk-index 同样口径：同一个会话、40 条一组）。 */
export function chunkArchive({ stateDir = './state', chunkMessages = DEF.chunkMessages, maxChunks = 2000 } = {}) {
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
    for (let i = 0; i < msgs.length; i += chunkMessages) {
      const slice = msgs.slice(i, i + chunkMessages);
      const text = slice.map((m) => `${m.me ? '我' : m.from}: ${String(m.text || '').slice(0, 200)}`).join('\n');
      if (text.trim().length < 40) continue;
      chunks.push({
        id: `${key}#${i}`,
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

/** 重建索引（全量）。 */
export async function rebuildIndex({ stateDir = './state', cfg = null, onProgress = null } = {}) {
  const c = memoryConfig(cfg);
  const chunks = chunkArchive({ stateDir, chunkMessages: c.chunkMessages });
  if (!chunks.length) return { ok: false, error: '归档里没有可索引的内容' };
  const texts = chunks.map((x) => x.text);
  const emb = await embedTexts({ texts, config: c, batch: 10 });
  if (!emb.ok) return emb;
  const items = chunks.map((x, i) => ({ ...x, vec: emb.vectors[i] }));
  saveIndex(stateDir, { version: 1, model: emb.model, dim: emb.dim, builtAt: Date.now(), items });
  onProgress?.(items.length);
  return { ok: true, items: items.length, dim: emb.dim, model: emb.model };
}

/** 召回：向量 topN → 重排 topK。 */
export async function recall({ stateDir = './state', cfg = null, query, limit = 3, conversationKey = '' } = {}) {
  const c = memoryConfig(cfg);
  const q = String(query || '').trim();
  if (q.length < 2) return { ok: true, hits: [] };
  const idx = loadIndex(stateDir);
  if (!idx.items?.length) return { ok: false, error: '索引为空，请先重建' };
  const qemb = await embedTexts({ texts: [q.slice(0, 500)], config: c, batch: 1 });
  if (!qemb.ok) return qemb;
  const qv = qemb.vectors[0];
  const scored = idx.items.map((it) => ({ item: it, score: cos(qv, it.vec) }));
  // 同会话的块略加权：召回"这个群里说过的话"通常更有用
  for (const s of scored) if (conversationKey && s.item.key === conversationKey) s.score += 0.05;
  scored.sort((a, b) => b.score - a.score);
  const cand = scored.slice(0, c.recallN);
  let hits = cand.slice(0, limit).map((s) => ({ ...s.item, vec: undefined, score: s.score }));
  let reranked = false;
  try {
    const rr = await rerank({ query: q.slice(0, 500), documents: cand.map((s) => s.item.text), config: c, topN: limit });
    if (rr.ok && rr.results.length) {
      hits = rr.results.map((r) => {
        const s = cand[r.index];
        return { ...s.item, vec: undefined, score: r.score, vecScore: s.score };
      });
      reranked = true;
    }
  } catch { /* 重排失败就用向量排序 */ }
  return { ok: true, hits, reranked, candidates: cand.length };
}

export function summarizeHits(hits) {
  if (!Array.isArray(hits) || !hits.length) return '';
  const fmt = (t) => new Date(Number(t) || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  return hits.map((h) => `【${fmt(h.from)}~${fmt(h.to)} · ${h.key}】${String(h.text).slice(0, 500)}`).join('\n');
}
