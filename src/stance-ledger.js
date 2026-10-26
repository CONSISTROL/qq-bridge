// 立场账本：记下它自己说过的"观点句"，同一话题再聊时把原话摆回它眼前，
// 防止在跟另一个 bot 对话时左右摇摆（实测：两条之内自己反转立场）。
//
// 不做语义分类（那要模型介入）；只按关键词重合找"同话题的旧立场"，成本极低。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'stances.json';
const MAX_PER_KEY = 120;
const TTL_MS = 14 * 86400000;

const STOP = new Set(['这个','那个','什么','就是','然后','可以','一个','没有','不是','还是','他们','我们','自己',
  '现在','已经','感觉','真的','但是','所以','因为','如果','这样','那样','的话','东西','时候','问题','其实','比较',
  '应该','可能','觉得','知道','看到','开始','地方','事情','一样','有点','一下','就是','这种','那种']);

function keywords(text) {
  const out = new Set();
  const str = String(text ?? '');
  for (const m of str.matchAll(/[\u4e00-\u9fff]{2,4}|[A-Za-z][A-Za-z0-9]{1,12}|\d{2,4}/g)) {
    const w = m[0].toLowerCase();
    if (STOP.has(w)) continue;
    if (/^\d+$/.test(w) && w.length < 2) continue;
    out.add(w);
  }
  // 中文补 2-gram：「嘴硬没用」→ 嘴硬/硬没/没用，短句之间也能对上
  for (const seg of str.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i + 2 <= seg.length; i += 1) {
      const bg = seg.slice(i, i + 2);
      if (!STOP.has(bg)) out.add(bg);
    }
  }
  return [...out].slice(0, 40);
}

function load(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    if (j && typeof j === 'object' && j.keys) return j;
  } catch { /* 忽略 */ }
  return { keys: {} };
}
function save(stateDir, data) {
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(data)); } catch { /* 忽略 */ }
}

/** 记一条立场（它自己发出的话）。 */
export function recordStance({ stateDir = './state', key = '', text = '', at = Date.now() } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length < 4) return { ok: false };
  const kw = keywords(t);
  if (kw.length < 2) return { ok: false };
  const data = load(stateDir);
  const list = (data.keys[key] || []).filter((s) => at - (Number(s.at) || 0) < TTL_MS);
  list.push({ text: t.slice(0, 120), kw, at });
  data.keys[key] = list.slice(-MAX_PER_KEY);
  save(stateDir, data);
  return { ok: true };
}

/** 找同话题的旧立场（关键词重合 ≥ minOverlap）。 */
export function findRelatedStances({ stateDir = './state', key = '', query = '', limit = 3, minOverlap = 0, now = Date.now() } = {}) {
  const q = new Set(keywords(query));
  if (!q.size) return [];
  // 短问句通常只谈一个话题（「本鲸爱嘴硬」），阈值放低；长句要求至少两处重合
  const need = minOverlap > 0 ? minOverlap : (String(query).length <= 12 ? 1 : 2);
  const list = (load(stateDir).keys[key] || []).filter((s) => now - (Number(s.at) || 0) < TTL_MS);
  const scored = [];
  for (const s of list) {
    const hit = (s.kw || []).filter((w) => q.has(w)).length;
    if (hit >= need) scored.push({ ...s, hit });
  }
  // 同一条文本只留最新一次
  const seen = new Set();
  return scored.sort((a, b) => b.hit - a.hit || b.at - a.at)
    .filter((s) => { if (seen.has(s.text)) return false; seen.add(s.text); return true; })
    .slice(0, limit);
}
