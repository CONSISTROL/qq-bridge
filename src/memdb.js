// 统一记忆库（一个 SQLite 数据库管所有"AI 记住的东西"）。
//
// 为什么合：黑话、群知识库、档案、轻量记忆（话题/想法/印象）、群成员备注、表情笔记原本各存各的
// JSON，查一次要读好几个文件、也做不了统一搜索。现在全部进 state/memory.db 的 items 表，
// 用 kind 区分类型，控制台只用一个页面查/改。
//
// 结构：items(id, kind, scope, text, answer, tags, status, at, updated, extra)
//   kind: slang(黑话) | knowledge(知识库) | fact(档案) | topic(话题) | thought(想法)
//         | impression(印象) | remark(成员备注) | sticker(表情笔记)
//   scope: all | owner | group:<id> | private:<qq> | ''（不限）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'memory.db';
let db = null;

export function openMemoryDb({ stateDir }) {
  if (db) return db;
  fs.mkdirSync(stateDir, { recursive: true });
  db = new DatabaseSync(path.join(stateDir, FILE));
  db.exec(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      scope TEXT DEFAULT '',
      text TEXT NOT NULL,
      answer TEXT DEFAULT '',
      tags TEXT DEFAULT '',
      status TEXT DEFAULT '',
      at INTEGER DEFAULT 0,
      updated INTEGER DEFAULT 0,
      extra TEXT DEFAULT '',
      -- LSTM 式门控字段：importance=输入门（值不值得记），strength=遗忘门（强度，会衰减），
      -- lastUsed/useCount=输出门（被用过多少次，用得越多越难忘）
      importance REAL DEFAULT 0.5,
      strength REAL DEFAULT 1.0,
      lastUsed INTEGER DEFAULT 0,
      useCount INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_items_kind ON items(kind);
    CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope);
  `);
  // 老库补列（幂等）
  const cols = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
  for (const [name, ddl] of [['importance', 'REAL DEFAULT 0.5'], ['strength', 'REAL DEFAULT 1.0'], ['lastUsed', 'INTEGER DEFAULT 0'], ['useCount', 'INTEGER DEFAULT 0']]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE items ADD COLUMN ${name} ${ddl}`);
  }
  return db;
}

const row2item = (r) => ({
  id: r.id, kind: r.kind, scope: r.scope, text: r.text, answer: r.answer,
  tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
  status: r.status, at: r.at, updated: r.updated,
  extra: r.extra ? (() => { try { return JSON.parse(r.extra); } catch { return {}; } })() : {}
});

export function listItems({ stateDir, kind = '', scope = '', q = '', limit = 200, offset = 0 } = {}) {
  const d = openMemoryDb({ stateDir });
  const where = [];
  const args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (scope) { where.push('(scope = ? OR scope = \'\')'); args.push(scope); }
  if (q) { where.push('(text LIKE ? OR answer LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sql = `SELECT * FROM items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(updated, at) DESC LIMIT ? OFFSET ?`;
  args.push(Math.max(1, Math.min(2000, Number(limit) || 200)), Math.max(0, Number(offset) || 0));
  return d.prepare(sql).all(...args).map(row2item);
}

export function countItems({ stateDir, kind = '' } = {}) {
  const d = openMemoryDb({ stateDir });
  const rows = kind
    ? d.prepare('SELECT kind, COUNT(*) c FROM items WHERE kind = ? GROUP BY kind').all(kind)
    : d.prepare('SELECT kind, COUNT(*) c FROM items GROUP BY kind').all();
  const out = {};
  for (const r of rows) out[r.kind] = r.c;
  return out;
}

export function upsertItem({ stateDir, item = {}, now = Date.now() } = {}) {
  const d = openMemoryDb({ stateDir });
  const kind = String(item.kind || '').trim();
  const text = String(item.text || '').trim();
  if (!kind || !text) return { ok: false, error: 'kind / text 不能为空' };
  const id = String(item.id || `i${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  const tags = Array.isArray(item.tags) ? item.tags.join(',') : String(item.tags || '');
  d.prepare(`INSERT INTO items (id, kind, scope, text, answer, tags, status, at, updated, extra)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, scope=excluded.scope, text=excluded.text,
               answer=excluded.answer, tags=excluded.tags, status=excluded.status, updated=excluded.updated, extra=excluded.extra`)
    .run(id, kind, String(item.scope || ''), text, String(item.answer || ''), tags, String(item.status || ''), Number(item.at) || now, now, JSON.stringify(item.extra || {}));
  return { ok: true, id };
}

export function deleteItem({ stateDir, id }) {
  const d = openMemoryDb({ stateDir });
  const r = d.prepare('DELETE FROM items WHERE id = ?').run(String(id));
  return { ok: r.changes > 0 };
}

/** 从旧的 JSON 文件一次性导入（可重复执行，按 id 幂等）。 */
export function migrateFromJson({ stateDir, log = () => {} } = {}) {
  const d = openMemoryDb({ stateDir });
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); } catch { return fb; } };
  let n = 0;
  const put = (item) => { const r = upsertItem({ stateDir, item }); if (r.ok) n += 1; };

  for (const s of readJson('slang.json', [])) put({ id: `slang:${s.id}`, kind: 'slang', text: s.content || '', answer: s.meaning || '', status: s.status || '', tags: s.tags, at: s.at || s.createdAt });
  for (const k of readJson('knowledge.json', [])) put({ id: `kb:${k.id}`, kind: 'knowledge', text: k.question || '', answer: k.answer || '', status: k.status || '', tags: k.tags, at: k.at || k.createdAt });
  for (const p of (readJson('profile.json', { items: [] }).items || [])) put({ id: `fact:${p.id}`, kind: 'fact', scope: p.scope || 'all', text: p.text || '', tags: p.tags, at: p.at });
  const remarks = readJson('member-remarks.json', { conversations: {} });
  for (const [conv, members] of Object.entries(remarks.conversations || {})) {
    for (const [qq, m] of Object.entries(members || {})) {
      put({ id: `remark:${conv}:${qq}`, kind: 'remark', scope: conv, text: `${m.remark || ''}|${m.note || ''}`.replace(/^\|/, '') || qq, extra: { qq, nick: m.nick || '' } });
    }
  }
  const s2 = readJson('social-v2.json', { conversations: {} });
  for (const [conv, st] of Object.entries(s2.conversations || {})) {
    for (const t of (st.topics || [])) put({ id: `topic:${conv}:${t.id || t.at}`, kind: 'topic', scope: conv, text: t.text || '', at: t.at, extra: { participants: t.participants || [] } });
    for (const t of (st.thoughts || [])) put({ id: `thought:${conv}:${t.id || t.at}`, kind: 'thought', scope: conv, text: t.text || '', at: t.at });
    for (const [name, im] of Object.entries(st.impressions || {})) put({ id: `impression:${conv}:${name}`, kind: 'impression', scope: conv, text: `${name}：${(im.traits || []).join('、')}`, extra: { name, interactionCount: im.interactionCount || 0 } });
  }
  log(`[memdb] 迁移完成：共 ${n} 条（${Object.entries(countItems({ stateDir })).map(([k, v]) => k + '=' + v).join(' ') }）`);
  return { ok: true, count: n, byKind: countItems({ stateDir }) };
}

/**
 * LSTM 式「输出门」：按相关性 × 重要性 × 强度（衰减后）打分，只取 top-K 注入提示词。
 * 不再把档案全量塞进去——记忆越多，越需要"只唤起相关的"。
 */
export function recallForPrompt({ stateDir, key = '', query = '', limit = 10 } = {}) {
  const d = openMemoryDb({ stateDir });
  const rows = d.prepare(`SELECT * FROM items WHERE kind IN ('fact','knowledge','remark','slang','impression','topic')`).all();
  const q = String(query || '').toLowerCase();
  const now = Date.now();
  const scored = rows.map((r) => {
    const text = `${r.text} ${r.answer || ''}`.toLowerCase();
    // 词面相关：查询词命中多少（粗糙但够用；需要更准再上向量）
    let rel = 0;
    if (q) {
      const parts = q.split(/[\s,，。.!?、]+/).filter((w) => w.length >= 2);
      const hit = parts.filter((w) => text.includes(w)).length;
      rel = parts.length ? hit / parts.length : 0;
    }
    const imp = Number(r.importance ?? 0.5);
    const str = Number(r.strength ?? 1);
    // 会话相关：属于当前会话的加一点权重
    const scopeBoost = r.scope === 'all' ? 1 : (r.scope === key ? 1.15 : 0.9);
    // 相关性为主；没有 query 时用 重要度×强度 排序
    const score = (q ? (0.6 * rel + 0.25 * imp + 0.15 * str) : (0.6 * imp + 0.4 * str)) * scopeBoost;
    return { ...r, _score: score };
  }).filter((r) => (q ? r._score > 0.05 : true)).sort((a, b) => b._score - a._score).slice(0, limit);
  // 命中即"用过"：加 useCount、刷新 lastUsed（输出门反馈）
  const mark = d.prepare('UPDATE items SET useCount = useCount + 1, lastUsed = ? WHERE id = ?');
  for (const r of scored) mark.run(now, r.id);
  return scored.map((r) => ({ id: r.id, kind: r.kind, scope: r.scope, text: r.text, answer: r.answer || '', score: Number(r._score.toFixed(3)) }));
}

/**
 * LSTM 式「遗忘门」：按强度做指数衰减，弱的先掉；重要性高/被用过的衰减更慢。
 * strength 低于 0.15 且不是 fact/remark（人/群稳定事实）→ 直接删；其余保留但越来越难被唤起。
 */
export function decayMemories({ stateDir, halfLifeDays = 30, now = Date.now() } = {}) {
  const d = openMemoryDb({ stateDir });
  const rows = d.prepare('SELECT id, kind, strength, importance, lastUsed, at FROM items').all();
  let decayed = 0, dropped = 0;
  const upd = d.prepare('UPDATE items SET strength = ? WHERE id = ?');
  const del = d.prepare('DELETE FROM items WHERE id = ?');
  for (const r of rows) {
    const last = Number(r.lastUsed) || Number(r.at) || now;
    const days = Math.max(0, (now - last) / 86400000);
    if (days < 1) continue;
    const imp = Number(r.importance ?? 0.5);
    // 半衰期随重要性延长：imp=1 → 2×halfLife；imp=0 → 0.5×
    const tau = halfLifeDays * (0.5 + imp * 1.5);
    const factor = Math.pow(0.5, days / tau);
    const next = Math.max(0, Number(r.strength ?? 1) * factor);
    if (next < 0.15 && !['fact', 'remark'].includes(r.kind)) { del.run(r.id); dropped += 1; }
    else { upd.run(next, r.id); decayed += 1; }
  }
  return { ok: true, decayed, dropped };
}

/** 关闭当前数据库句柄（测试隔离用：每个临时 state 目录用完要放锁）。 */
export function closeMemoryDb() {
  if (!db) return;
  try { db.close(); } catch { /* 已经关了 */ }
  db = null;
}
