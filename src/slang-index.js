// 黑话库的向量索引与检索打分。
//
// 分工：
//   * 嵌入（embedding）由本地子进程负责（src/embedder.js），本模块只管「存哪些向量、什么时候重建、怎么排」；
//   * 检索打分不只看语义相似度，还叠了「本会话出现过没有/出现过几次」和「时间衰减」——
//     因为向量不知道你在哪个群，而 A 群的热梗在 B 群不该占坑位。
//
// 实测结论（详见 docs）：语义相关的对余弦 ≥0.55，无关的 ≤0.31，中间有干净空隙，
// 所以 minCosine 默认取 0.32 作为「够不够相关」的门槛。
import fs from 'node:fs';
import path from 'node:path';

export const VECTOR_MODEL = 'Xenova/bge-small-zh-v1.5';

/** 默认打分权重（可在 config.socialV2.rag.weights 覆盖） */
export const DEFAULT_WEIGHTS = Object.freeze({
  sem: 1.0,      // 语义相似度
  conv: 0.15,    // 本会话出现次数（log1p）
  global: 0.03,  // 全库出现次数（log1p）
  recency: 0.05, // 近期活跃度（30 天半衰）
});

// 注意：这个阈值是**实测校准**出来的，不是拍的。
// 早期用手挑的 7 对样本估出「相关 ≥0.55、无关 ≤0.31」，但放到全库规模上不成立——
// 大量无关词条两两余弦落在 0.35~0.50。调试面板实测：一条查询里 eligible=63/73，
// 除第 1 名(0.545)外全是噪声。所以门槛提到 0.5（贴着相关下沿，留一点余量）。
export const DEFAULT_MIN_COSINE = 0.5;

/** 参与编码的文本：词条 + 释义。释义是检索质量的主要来源。 */
export function entryText(entry) {
  const content = String(entry?.content ?? '').trim();
  const meaning = String(entry?.meaning ?? '').trim();
  const usage = String(entry?.usage ?? '').trim();
  return [content, meaning, usage].filter(Boolean).join('：');
}

/** 内容指纹：释义/用法改了就要重新编码，否则会检索到旧语义。 */
export function entryHash(entry) {
  const s = `${entry?.content ?? ''}\u0001${entry?.meaning ?? ''}\u0001${entry?.usage ?? ''}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16) + h2.toString(16);
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 向量已归一化，点积即余弦
}

// ── 向量库文件 ────────────────────────────────────────────────────────
export function loadVectorStore(file) {
  const empty = { model: VECTOR_MODEL, dim: 0, builtAt: '', vectors: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.vectors !== 'object') return empty;
    // 换了模型/维度就整体作废，避免拿不同模型的向量互相算余弦
    if (parsed.model !== VECTOR_MODEL) {
      return { ...empty, note: `模型从 ${parsed.model} 变为 ${VECTOR_MODEL}，索引需要重建` };
    }
    return { model: VECTOR_MODEL, dim: Number(parsed.dim) || 0, builtAt: parsed.builtAt || '', vectors: parsed.vectors };
  } catch {
    return empty;
  }
}

export function saveVectorStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── 重建计划 ──────────────────────────────────────────────────────────
/** 哪些词条缺向量或内容变了；哪些向量已经没有对应词条了。 */
export function planRebuild(entries, store) {
  const vectors = store?.vectors || {};
  const alive = new Set();
  const toEmbed = [];
  for (const e of entries) {
    if (!e?.id || !e.content || !String(e.meaning || '').trim()) continue;
    alive.add(e.id);
    const rec = vectors[e.id];
    if (!rec || rec.h !== entryHash(e) || !Array.isArray(rec.v) || !rec.v.length) toEmbed.push(e);
  }
  const orphans = Object.keys(vectors).filter((id) => !alive.has(id));
  return { toEmbed, orphans };
}

/**
 * 把缺的向量补上。
 * @param {object} opts
 * @param {Array} opts.entries
 * @param {{embed:Function}} opts.client
 * @param {object} opts.store   会被就地更新并返回
 * @param {number} [opts.batch] 每批文本数（实测必须小：一次 104 条会被 OOM 杀）
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 */
export async function buildIndex({ entries, client, store, batch = 8, onProgress } = {}) {
  const { toEmbed, orphans } = planRebuild(entries, store);
  for (const id of orphans) delete store.vectors[id];
  if (!toEmbed.length) {
    if (orphans.length) store.builtAt = new Date().toISOString();
    return { embedded: 0, orphans: orphans.length, total: Object.keys(store.vectors).length };
  }
  let done = 0;
  for (let i = 0; i < toEmbed.length; i += batch) {
    const chunk = toEmbed.slice(i, i + batch);
    const vectors = await client.embed(chunk.map(entryText));
    chunk.forEach((e, k) => {
      const v = vectors[k];
      if (!Array.isArray(v) || !v.length) return;
      store.vectors[e.id] = { h: entryHash(e), v: v.map((x) => +x.toFixed(5)) };
    });
    done += chunk.length;
    store.dim = store.dim || (vectors[0]?.length ?? 0);
    onProgress?.(Math.min(done, toEmbed.length), toEmbed.length);
  }
  store.builtAt = new Date().toISOString();
  return { embedded: done, orphans: orphans.length, total: Object.keys(store.vectors).length };
}

// ── 打分与检索 ────────────────────────────────────────────────────────
/** 从 evidence 推导每个会话里这个词出现过几次、最近一次什么时候。 */
export function deriveByKey(entry) {
  const out = {};
  for (const ev of (entry?.evidence || [])) {
    const key = String(ev?.key || '').trim();
    if (!key) continue;
    const t = Number(ev?.time) || 0;
    if (!out[key]) out[key] = { count: 0, lastAt: 0 };
    out[key].count++;
    if (t > out[key].lastAt) out[key].lastAt = t;
  }
  return out;
}

/**
 * 给候选词条打分排序。
 * 资格线只由语义决定（base ≥ minCosine）。
 * 会话维度只参与打分、不作为资格豁免——早先版本让 conv>0 直接获得资格，
 * 结果是一个群里出现过的词（本库 58/73）几乎全都能进，等于把噪声放了进来。
 * 群内自造词（余弦天然偏低）改由 selectForInjection 的 minFill 兜底带出。
 */
export function scoreEntries({ queryVec, entries, store, key = '', weights = {}, minCosine = DEFAULT_MIN_COSINE, now = Date.now() }) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const vectors = store?.vectors || {};
  const rows = [];
  for (const e of entries) {
    const rec = vectors[e?.id];
    if (!rec || !Array.isArray(rec.v)) continue;
    const base = cosine(queryVec, rec.v);
    const byKey = deriveByKey(e);
    const conv = key && byKey[key] ? byKey[key].count : 0;
    const lastAt = key && byKey[key] ? byKey[key].lastAt : 0;
    if (base < minCosine) continue;
    const ageDays = lastAt ? Math.max(0, (now - lastAt) / 86400000) : 999;
    const recency = Math.exp(-ageDays / 30);
    const score = base * w.sem
      + Math.log1p(conv) * w.conv
      + Math.log1p(Number(e.count) || 0) * w.global
      + recency * w.recency;
    rows.push({ entry: e, score, sem: base, conv, recency, inThisConv: conv > 0 });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/**
 * 选出要注入的 top-K。
 * 相关的不够 minFill 条时，用「本群高频 + 全库高频」补齐——
 * 避免某轮一条都不相关时 AI 完全看不到群内常用语（保留旧行为的兜底价值）。
 */
export function selectForInjection({
  queryVec, entries, store, key = '', max = 8, minFill = 3,
  weights, minCosine, now,
  // 相对判据：只看绝对阈值时，0.50~0.57 这一段会挤进一批弱相关词
  // （实测「评价一下blg bin」里 top-1 是 0.75，后面全在 0.50~0.52）。
  // 所以再要求「离 top-1 不太远」，比单纯调高绝对值更稳。
  relativeMargin = 0.08
}) {
  const ranked = scoreEntries({ queryVec, entries, store, key, weights, minCosine, now });
  const cutoff = ranked.length ? Math.max(minCosine ?? DEFAULT_MIN_COSINE, ranked[0].sem - relativeMargin) : 0;
  const picked = ranked.filter((r) => r.sem >= cutoff).slice(0, max);
  const pickedIds = new Set(picked.map((r) => r.entry.id));
  if (picked.length < Math.min(minFill, max)) {
    const filler = entries
      .filter((e) => e?.id && !pickedIds.has(e.id) && String(e.meaning || '').trim())
      .map((e) => {
        const byKey = deriveByKey(e);
        const conv = key && byKey[key] ? byKey[key].count : 0;
        return { entry: e, conv, freq: (Number(e.count) || 0) + conv * 10 };
      })
      .sort((a, b) => b.freq - a.freq);
    for (const f of filler) {
      if (picked.length >= Math.min(minFill, max)) break;
      picked.push({ entry: f.entry, score: 0, sem: 0, conv: f.conv, recency: 0, filler: true });
      pickedIds.add(f.entry.id);
    }
  }
  return { picked, ranked: ranked.length, eligible: ranked.length, cutoff: +cutoff.toFixed(4) };
}

/** 近义聚类：余弦高于阈值的词条两两配对，交给人工决定合并/别名/忽略。 */
export function nearDuplicates({ entries, store, threshold = 0.62, limit = 40 }) {
  const vectors = store?.vectors || {};
  const withVec = entries.filter((e) => e?.id && Array.isArray(vectors[e.id]?.v));
  const pairs = [];
  for (let i = 0; i < withVec.length; i++) {
    for (let j = i + 1; j < withVec.length; j++) {
      const sim = cosine(vectors[withVec[i].id].v, vectors[withVec[j].id].v);
      if (sim >= threshold) {
        pairs.push({
          a: { id: withVec[i].id, content: withVec[i].content },
          b: { id: withVec[j].id, content: withVec[j].content },
          sim: +sim.toFixed(3)
        });
      }
    }
  }
  pairs.sort((x, y) => y.sim - x.sim);
  return pairs.slice(0, limit);
}
