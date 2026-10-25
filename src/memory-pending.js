// 记忆候选（待核实）：规则先抓出"可能值得记"的内容，**核实后再入库**。
//
// 为什么要有这一步：线上真实事故——群里聊「369 打瓦」，bot 当场总结成
// 「撸的 369 和瓦的 369 是两个不同的人」，实际上 369 就是 TES 上单白家浩，
// 他转型/去打无畏契约被弹幕嘲。凭印象写进长期记忆＝把错误固化。
// 所以候选必须经过：查资料 / 问群里 / 翻归档，确认后才写入。
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'memory-pending.json';
const MAX_PENDING = 60;
const TTL_MS = 3 * 24 * 3600 * 1000;   // 3 天没核实就丢掉

function load(stateDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    if (j && Array.isArray(j.items)) return j;
  } catch { /* 忽略 */ }
  return { items: [] };
}
function save(stateDir, data) {
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(path.join(stateDir, FILE), JSON.stringify(data, null, 1)); } catch { /* 忽略 */ }
}

/** 加一条候选（同样内容不重复加）。 */
export function addCandidate({ stateDir = './state', key = '', text = '', evidence = '', kind = 'fact', now = Date.now() } = {}) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return { ok: false, error: '内容为空' };
  const data = load(stateDir);
  data.items = data.items.filter((x) => now - (Number(x.at) || 0) < TTL_MS);
  if (data.items.some((x) => x.key === key && x.text === t)) return { ok: true, dup: true };
  data.items.push({ id: `c${now.toString(36)}`, key, kind: String(kind || 'fact'), text: t, evidence: String(evidence ?? '').slice(0, 500), at: now, status: 'pending' });
  if (data.items.length > MAX_PENDING) data.items = data.items.slice(-MAX_PENDING);
  save(stateDir, data);
  return { ok: true, id: data.items[data.items.length - 1].id };
}

export function listPending({ stateDir = './state', key = '', limit = 5, now = Date.now() } = {}) {
  const data = load(stateDir);
  return data.items
    .filter((x) => x.status === 'pending' && (!key || x.key === key))
    .filter((x) => now - (Number(x.at) || 0) < TTL_MS)
    .slice(-limit);
}

export function allPending({ stateDir = './state' } = {}) {
  return load(stateDir).items.filter((x) => x.status === 'pending');
}

/** 核实结果回填：confirmed / wrong / skip。 */
export function resolveCandidate({ stateDir = './state', id = '', verdict = 'skip', text = '', source = '', now = Date.now() } = {}) {
  const data = load(stateDir);
  const it = data.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: `找不到候选 ${id}` };
  it.status = ['confirmed', 'wrong', 'skip'].includes(verdict) ? verdict : 'skip';
  if (text) it.text = String(text).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (source) it.source = String(source).slice(0, 300);
  it.resolvedAt = now;
  save(stateDir, data);
  return { ok: true, item: it };
}
