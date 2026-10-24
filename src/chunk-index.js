// 原文分块索引（chunk RAG）：把聊天归档按固定条数切块，块向量存 sidecar 文件。
//
// 为什么不再"抽取条目"：抽取是有损的（1669 条聊天只压出 9 条摘要），而原文块是 100% 覆盖、
// 保真（能拿到当时原话和上下文）。条目库继续保留，用来存"高价值事实"，但检索主力换成这里。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'chunk-vectors.json';
const MODEL = 'Xenova/bge-small-zh-v1.5';
const CHUNK_MESSAGES = 40;      // 每块最多多少条消息
const CHUNK_MAX_CHARS = 900;    // 块文本上限
const KEEP_CHUNKS = 4000;       // 最多保留多少块（超出丢最旧的）

const convDirToKey = (name) => {
  const m = /^(group|private)_(\d+)$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : '';
};

function readConvRecords(stateDir, convDir) {
  const folder = path.join(stateDir, 'messages', convDir);
  const out = [];
  let files = [];
  try { files = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return out; }
  for (const f of files) {
    let raw = '';
    try { raw = fs.readFileSync(path.join(folder, f), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
    }
  }
  return out;
}

const isPlaceholder = (t) => /^\[(图片|动画表情|表情|视频|文件|语音|音频|转发消息|卡片)/.test(String(t || ''));

/** 把一批消息压成块文本（保留"谁说了什么"）。 */
function chunkText(records) {
  const lines = [];
  for (const r of records) {
    const t = String(r.text ?? '').replace(/\s+/g, ' ').trim();
    if (!t || isPlaceholder(t)) continue;
    const who = r.me ? '我' : String(r.from || '群友').slice(0, 12);
    lines.push(`${who}：${t.slice(0, 60)}`);
  }
  let text = lines.join(' / ');
  if (text.length > CHUNK_MAX_CHARS) text = text.slice(0, CHUNK_MAX_CHARS) + '…';
  return text;
}

export function loadChunkIndex(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    if (j && Array.isArray(j.chunks)) return j;
  } catch { /* 忽略 */ }
  return { version: 1, model: MODEL, chunks: [] };
}

export function saveChunkIndex(stateDir, idx) {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(idx));
  } catch { /* 忽略 */ }
}

/**
 * 增量重建：只处理"比已索引块更新"的消息。
 * @param embed (text)=>Promise<number[]>
 */
export async function updateChunkIndex({ stateDir = './state', embed, maxChunks = KEEP_CHUNKS } = {}) {
  const idx = loadChunkIndex(stateDir);
  const byKey = new Map(idx.chunks.map((c) => [c.id, c]));
  const lastAtByKey = new Map();
  for (const c of idx.chunks) lastAtByKey.set(c.key, Math.max(lastAtByKey.get(c.key) || 0, Number(c.to) || 0));

  let added = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(stateDir, 'messages')); } catch { return { ok: false, added: 0 }; }
  for (const dir of dirs) {
    const key = convDirToKey(dir);
    if (!key) continue;
    const lastAt = lastAtByKey.get(key) || 0;
    const fresh = readConvRecords(stateDir, dir).filter((r) => Number(r.t || 0) > lastAt);
    if (!fresh.length) continue;
    for (let i = 0; i < fresh.length; i += CHUNK_MESSAGES) {
      const part = fresh.slice(i, i + CHUNK_MESSAGES);
      const text = chunkText(part);
      if (!text || text.length < 20) continue;
      const from = Number(part[0]?.t) || Date.now();
      const to = Number(part[part.length - 1]?.t) || from;
      const id = `${key}:${from}`;
      if (byKey.has(id)) continue;
      const vec = await embed(text);
      if (!Array.isArray(vec) || !vec.length) continue;
      byKey.set(id, { id, key, from, to, n: part.length, text, vec });
      added += 1;
    }
  }
  let chunks = [...byKey.values()].sort((a, b) => a.to - b.to);
  if (chunks.length > maxChunks) chunks = chunks.slice(-maxChunks);
  saveChunkIndex(stateDir, { version: 1, model: MODEL, chunks });
  return { ok: true, added, total: chunks.length };
}

const cos = (x, y) => {
  let dot = 0, nx = 0, ny = 0;
  for (let i = 0; i < x.length; i++) { dot += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i]; }
  return dot / (Math.sqrt(nx) * Math.sqrt(ny) || 1);
};

/** 检索 top-k 原文块（同会话优先）。 */
export function searchChunks({ stateDir = './state', key = '', qvec, limit = 3, minScore = 0.45 } = {}) {
  if (!Array.isArray(qvec) || !qvec.length) return [];
  const idx = loadChunkIndex(stateDir);
  const scored = [];
  for (const c of idx.chunks) {
    if (!Array.isArray(c.vec) || c.vec.length !== qvec.length) continue;
    const s = cos(qvec, c.vec) * (c.key === key ? 1.08 : 1);
    if (s >= minScore) scored.push({ ...c, score: s, vec: undefined });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
